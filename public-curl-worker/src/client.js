// HTTP operations behind the curl tools. Arguments arrive validated, with schema defaults applied.

import { ToolError } from "../../shared/schema.js";
import { decodeText, fetchFailure, isTextualMediaType, mediaTypeOf, parsePublicHttpUrl, readBody, unreachableHostError } from "../../shared/fetch.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const CHECK_BODY_BYTES = 1024;
// Some APIs, GitHub's among them, reject requests without a User-Agent.
const DEFAULT_USER_AGENT = "mcp-web-tools/2.0 (+https://github.com/ZhenHuangLab/mcp-web-tools)";

// Connection-level headers are managed by the runtime.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"
]);
// Credentials are not sent on to a different origin when a redirect is followed.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const BODY_HEADERS = ["content-type", "content-encoding", "content-language", "content-location"];

/**
 * Sends one request and follows redirects as asked. Returns `{ request, response }`; the response
 * body is UTF-8 text for textual media types and base64 for everything else.
 */
export async function sendRequest(args) {
  const requestUrl = parsePublicHttpUrl(args.url);
  const headers = requestHeaders(args.headers);
  if (args.body !== undefined) {
    if (args.method === "GET" || args.method === "HEAD") {
      throw new ToolError(`${args.method} requests cannot have a body.`);
    }
    if (new TextEncoder().encode(args.body).byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new ToolError(`The request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes.`, 413);
    }
  }

  const signal = AbortSignal.timeout(args.timeoutMs);
  let url = requestUrl;
  let method = args.method;
  let body = args.body;
  let redirectsFollowed = 0;
  try {
    while (true) {
      const response = await fetch(url.href, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        cache: "no-store",
        signal
      });
      const unreachable = await unreachableHostError(response, url);
      if (unreachable) throw unreachable;

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
      if (!isRedirect || args.redirect === "manual") {
        return await describeResponse(response, {
          request: { url: requestUrl.href, method: args.method, redirect: args.redirect, redirectsFollowed },
          url,
          maxBytes: args.maxResponseBytes
        });
      }

      await response.body?.cancel();
      if (args.redirect === "error") {
        throw new ToolError(`The server redirected (HTTP ${response.status}) to ${location}, and redirect is set to "error".`, 502);
      }
      if (redirectsFollowed >= MAX_REDIRECTS) {
        throw new ToolError(`Stopped after ${MAX_REDIRECTS} redirects. The last one pointed to ${location}.`, 502);
      }

      const nextUrl = redirectTarget(location, url);
      if (nextUrl.origin !== url.origin) {
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      }
      // 303, and 301/302 after POST, turn the request into a GET without a body (Fetch standard).
      if ((response.status === 303 && method !== "HEAD") || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        for (const name of BODY_HEADERS) headers.delete(name);
      }
      url = nextUrl;
      redirectsFollowed += 1;
    }
  } catch (error) {
    throw fetchFailure(error, signal, args.timeoutMs);
  }
}

/** Sends a request and parses the response body as JSON. */
export async function fetchJson(args) {
  const hasAccept = Object.keys(args.headers ?? {}).some((name) => name.toLowerCase() === "accept");
  const result = await sendRequest(hasAccept ? args : { ...args, headers: { ...args.headers, Accept: "application/json" } });
  const { response } = result;
  const contentType = response.headers["content-type"] ?? "no Content-Type";

  if (response.bodyEncoding !== "utf-8") {
    throw new ToolError(`The response (HTTP ${response.status}) is ${contentType}, not JSON text.`, 502);
  }
  if (response.truncated) {
    throw new ToolError(`The JSON response is larger than maxResponseBytes (${args.maxResponseBytes} bytes). Raise maxResponseBytes, up to 1048576, to parse it.`, 502);
  }
  let data;
  try {
    data = response.body.trim() === "" ? null : JSON.parse(response.body);
  } catch {
    const start = response.body.slice(0, 300).replace(/\s+/g, " ");
    throw new ToolError(`The response (HTTP ${response.status}, ${contentType}) is not valid JSON. It starts with: ${start}`, 502);
  }

  const { body, bodyEncoding, ...metadata } = response;
  return { request: result.request, response: { ...metadata, bodyEncoding: "json", data } };
}

/**
 * Checks whether a URL responds, with HEAD and, when the server rejects HEAD, a small GET.
 * Network failures and timeouts are a result (`reachable: false`), not an error.
 */
export async function checkUrl(args) {
  const url = parsePublicHttpUrl(args.url).href;
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  const attempt = (method) => sendRequest({
    url,
    method,
    headers: args.headers,
    redirect: args.redirect,
    timeoutMs: args.timeoutMs,
    maxResponseBytes: CHECK_BODY_BYTES
  });

  let methodUsed = "HEAD";
  let result;
  try {
    result = await attempt(methodUsed);
    if (args.fallbackToGet && (result.response.status === 405 || result.response.status === 501)) {
      methodUsed = "GET";
      result = await attempt(methodUsed);
    }
  } catch (error) {
    if (!(error instanceof ToolError) || error.status < 500) throw error;
    return { url, reachable: false, status: null, error: error.message, methodUsed, elapsedMs: elapsedMs() };
  }

  const { response, request } = result;
  return {
    url,
    reachable: true,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    finalUrl: response.url,
    methodUsed,
    redirectsFollowed: request.redirectsFollowed,
    elapsedMs: elapsedMs(),
    contentType: response.headers["content-type"] ?? null,
    contentLength: response.headers["content-length"] ?? null
  };
}

/** Sends up to five requests with limited concurrency. Each item succeeds or fails on its own. */
export async function batchRequest(args) {
  const { requests, maxConcurrency } = args;
  const results = new Array(requests.length);
  let next = 0;

  async function worker() {
    while (next < requests.length) {
      const index = next;
      next += 1;
      try {
        const result = await sendRequest(requests[index]);
        results[index] = { index, completed: true, httpOk: result.response.ok, result };
      } catch (error) {
        if (!(error instanceof ToolError)) console.error("Batch item failed:", error);
        results[index] = { index, completed: false, error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, requests.length) }, worker));
  const succeeded = results.filter((item) => item.completed).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
}

async function describeResponse(response, { request, url, maxBytes }) {
  const { bytes, truncated } = await readBody(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "";
  const textual = isTextualMediaType(mediaTypeOf(contentType));
  return {
    request,
    response: {
      url: url.href,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: headerObject(response.headers),
      bodyEncoding: textual ? "utf-8" : "base64",
      bodyBytes: bytes.byteLength,
      truncated,
      body: textual ? decodeText(bytes, contentType) : bytes.toBase64()
    }
  };
}

function requestHeaders(input = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new ToolError(`The ${name} header is managed by the runtime and cannot be set.`);
    }
    try {
      headers.set(name, value);
    } catch (error) {
      throw new ToolError(`Invalid request header ${name}: ${error.message}`);
    }
  }
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT);
  return headers;
}

/** Response headers as an object. Set-Cookie is an array, because its values cannot be joined. */
function headerObject(headers) {
  const result = {};
  for (const [name, value] of headers) {
    if (name !== "set-cookie") result[name] = value;
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) result["set-cookie"] = cookies;
  return result;
}

function redirectTarget(location, base) {
  try {
    return parsePublicHttpUrl(new URL(location, base).href);
  } catch (error) {
    throw new ToolError(`The redirect to ${location} was rejected: ${error.message}`, 502);
  }
}
