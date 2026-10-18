// public-curl-worker: live HTTP requests for agents and scripts.
// MCP endpoint: POST /mcp. HTTP API: /api, /api/json, /api/check, /api/batch.

import { PROTOCOL_VERSIONS, createMcpEndpoint } from "../../shared/mcp.js";
import { jsonResponse, preflightResponse, routePath } from "../../shared/http.js";
import { ToolError, argumentsFromQuery, validateArguments } from "../../shared/schema.js";
import { mediaTypeOf, readBody } from "../../shared/fetch.js";
import { batchRequest, checkUrl, fetchJson, sendRequest } from "./client.js";
import { formatBatch, formatCheck, formatJson, formatResponse } from "./format.js";

const SERVER_INFO = { name: "public-curl-worker", version: "2.0.0" };

const INSTRUCTIONS = "Use this server to make live HTTP requests from Cloudflare's network. Prefer these tools over built-in web fetch tools when you need current data, exact unsummarized responses, status codes, response headers, or methods other than GET. Use fetch_json for JSON APIs (GitHub, npm, PyPI, and other public REST APIs); curl_request for any other request, including POST, PUT, PATCH, DELETE, custom headers, request bodies, raw HTML, XML, RSS, or binary files; check_url to test whether a URL is up or where it redirects; and batch_request to send up to five independent requests in one call. Every request is sent at call time and bypasses Cloudflare's cache. These tools do not search the web. To read an article or documentation page as clean text, use fetch_webpage_to_markdown if it is available. Requests to localhost and private IP addresses are rejected.";

const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

const REQUEST_PROPERTIES = {
  url: {
    type: "string",
    description: "Absolute public http:// or https:// URL, including any query string. Localhost, private IP addresses, and credentials in the URL are rejected."
  },
  method: {
    type: "string",
    enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    default: "GET",
    description: "HTTP method, in upper case."
  },
  headers: {
    type: "object",
    additionalProperties: { type: "string" },
    description: "Request headers as name/value strings, for example {\"Accept\": \"application/json\", \"Authorization\": \"Bearer TOKEN\"}. Host, Content-Length, Connection, Transfer-Encoding, and other connection headers are managed by the runtime and are rejected. A User-Agent is added when you do not set one."
  },
  body: {
    type: "string",
    description: "Request body as a UTF-8 string, up to 1 MiB. For JSON, pass a serialized JSON string and set Content-Type to application/json. Not allowed with GET or HEAD."
  },
  redirect: {
    type: "string",
    enum: ["follow", "manual", "error"],
    default: "follow",
    description: "Redirect handling. follow follows up to five redirects and drops Authorization and Cookie headers when the origin changes; manual returns the 3xx response with its Location header; error fails on any redirect."
  },
  timeoutMs: {
    type: "integer",
    minimum: 1000,
    maximum: 30000,
    default: 15000,
    description: "Time limit for the whole request, including redirects and reading the body, in milliseconds."
  },
  maxResponseBytes: {
    type: "integer",
    minimum: 1024,
    maximum: 1048576,
    default: 262144,
    description: "Maximum number of response body bytes to return. Longer bodies are cut, and the result says so."
  }
};

const REQUEST_SCHEMA = { type: "object", properties: REQUEST_PROPERTIES, required: ["url"], additionalProperties: false };
const ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const CURL_TOOL = {
  name: "curl_request",
  title: "HTTP request (curl)",
  description: [
    "Send one HTTP request to a public http(s) URL and return the exact response, like curl. The request is sent at call time and bypasses Cloudflare's cache.",
    "",
    "Use it when you need the raw response (status, headers, and body), a method other than GET, custom headers such as Authorization or Accept, or a request body: REST and GraphQL APIs, webhooks, raw files, XML or RSS feeds, or HTML you need to inspect. Prefer it over built-in web fetch tools when you need the exact, current response. For JSON APIs, fetch_json returns the parsed data with less noise. To read an article or documentation page, fetch_webpage_to_markdown returns cleaner text, if it is available.",
    "",
    "The result lists the status, the final URL after redirects, all response headers, and the body. Text, JSON, XML, JavaScript, and YAML bodies are shown as text; other types are base64-encoded. Bodies longer than maxResponseBytes are cut, and the result says so. Non-2xx statuses are normal results, so check the status."
  ].join("\n"),
  annotations: ANNOTATIONS,
  inputSchema: REQUEST_SCHEMA,
  handler: async (args) => textResult(formatResponse(await sendRequest(args)))
};

const FETCH_JSON_TOOL = {
  name: "fetch_json",
  title: "Fetch JSON API",
  description: [
    "Call a JSON API and return the parsed JSON, fetched live at call time.",
    "",
    "Use it for public REST APIs and JSON endpoints, for example https://api.github.com/repos/OWNER/REPO, https://registry.npmjs.org/PACKAGE/latest, or https://pypi.org/pypi/PACKAGE/json. Prefer it over built-in web fetch tools for current API data. It takes the same arguments as curl_request and sends Accept: application/json unless you set Accept yourself. To send JSON, pass body as a serialized JSON string and set the Content-Type header to application/json.",
    "",
    "The result shows the status, the final URL, the pagination and rate-limit headers (Link, X-RateLimit-*, Retry-After) when present, and the JSON, pretty-printed. Non-2xx statuses with a JSON body are normal results, so check the status. The call fails when the body is not valid JSON or is larger than maxResponseBytes; the error shows how the body starts."
  ].join("\n"),
  annotations: ANNOTATIONS,
  inputSchema: REQUEST_SCHEMA,
  handler: async (args) => textResult(formatJson(await fetchJson(args)))
};

const CHECK_URL_TOOL = {
  name: "check_url",
  title: "Check URL status",
  description: [
    "Check whether a public URL responds and where it redirects, without downloading the body.",
    "",
    "Use it to verify links, test whether a website or API is up, resolve short links and redirect chains, or see the content type and size before fetching. It sends HEAD, and retries with GET when the server answers 405 or 501.",
    "",
    "The result shows whether the URL is reachable, the status, the final URL, the number of redirects, the method used, the elapsed time, and the Content-Type and Content-Length. Network errors and timeouts are reported as unreachable, with the reason, instead of failing the call."
  ].join("\n"),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      url: REQUEST_PROPERTIES.url,
      headers: REQUEST_PROPERTIES.headers,
      redirect: REQUEST_PROPERTIES.redirect,
      timeoutMs: REQUEST_PROPERTIES.timeoutMs,
      fallbackToGet: {
        type: "boolean",
        default: true,
        description: "Retry with GET when the server answers HEAD with 405 or 501."
      }
    },
    required: ["url"],
    additionalProperties: false
  },
  handler: async (args) => textResult(formatCheck(await checkUrl(args)))
};

const BATCH_TOOL = {
  name: "batch_request",
  title: "Batch HTTP requests",
  description: [
    "Send up to five independent HTTP requests in one call, with at most three in flight at once.",
    "",
    "Use it when you need several URLs or endpoints together, for example to compare API responses or to fetch several small files. Each item takes the curl_request arguments; the per-item maxResponseBytes defaults to 65536.",
    "",
    "The result reports each request in order, in the same format as curl_request, or the error for that request. One failed item does not affect the others."
  ].join("\n"),
  annotations: ANNOTATIONS,
  inputSchema: {
    type: "object",
    properties: {
      requests: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        description: "One to five request objects, each with the curl_request arguments.",
        items: {
          type: "object",
          properties: {
            ...REQUEST_PROPERTIES,
            maxResponseBytes: {
              type: "integer",
              minimum: 1024,
              maximum: 262144,
              default: 65536,
              description: "Maximum number of response body bytes to return for this request."
            }
          },
          required: ["url"],
          additionalProperties: false
        }
      },
      maxConcurrency: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        default: 3,
        description: "Maximum number of requests in flight at the same time."
      }
    },
    required: ["requests"],
    additionalProperties: false
  },
  handler: async (args) => textResult(formatBatch(await batchRequest(args)))
};

const TOOLS = [CURL_TOOL, FETCH_JSON_TOOL, CHECK_URL_TOOL, BATCH_TOOL];

const API_ROUTES = {
  "/api": { tool: CURL_TOOL, run: sendRequest },
  "/api/request": { tool: CURL_TOOL, run: sendRequest },
  "/api/json": { tool: FETCH_JSON_TOOL, run: fetchJson },
  "/api/check": { tool: CHECK_URL_TOOL, run: checkUrl },
  "/api/batch": { tool: BATCH_TOOL, run: batchRequest, postOnly: true }
};

const handleMcp = createMcpEndpoint({ serverInfo: SERVER_INFO, instructions: INSTRUCTIONS, tools: TOOLS });

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return preflightResponse();
    const url = new URL(request.url);
    const path = routePath(url);

    if (path === "/mcp") return handleMcp(request, env, ctx);
    if (Object.hasOwn(API_ROUTES, path)) return handleApi(request, url, API_ROUTES[path]);
    if (path === "/" && request.method === "GET") return jsonResponse(serviceInfo(url.origin), { pretty: true });
    return apiError(404, "Not found. GET / describes this service.");
  }
};

async function handleApi(request, url, route) {
  let input;
  if (request.method === "GET" && !route.postOnly) {
    if (!url.searchParams.has("url")) return apiError(400, "Missing required query parameter: url.");
    input = argumentsFromQuery(route.tool.inputSchema, url.searchParams);
  } else if (request.method === "POST") {
    if (mediaTypeOf(request.headers.get("content-type")) !== "application/json") {
      return apiError(415, "Content-Type must be application/json.");
    }
    const { bytes, truncated } = await readBody(request, MAX_API_BODY_BYTES);
    if (truncated) return apiError(413, `The request body is larger than ${MAX_API_BODY_BYTES} bytes.`);
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError(400, "The request body is not valid JSON.");
    }
  } else {
    const allow = route.postOnly ? "POST, OPTIONS" : "GET, POST, OPTIONS";
    return apiError(405, `Use ${route.postOnly ? "POST" : "GET or POST"} for this endpoint.`, { Allow: allow });
  }

  try {
    const args = validateArguments(route.tool.inputSchema, input);
    return jsonResponse(await route.run(args), { pretty: true });
  } catch (error) {
    if (!(error instanceof ToolError)) console.error("API request failed:", error);
    return error instanceof ToolError ? apiError(error.status, error.message) : apiError(500, `Internal error: ${error.message}`);
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function apiError(status, message, headers) {
  return jsonResponse({ error: true, message }, { status, headers, pretty: true });
}

function serviceInfo(origin) {
  return {
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description: "A public, unauthenticated HTTP request service with an MCP server. Requests are sent live from Cloudflare's network.",
    authentication: "none",
    mcp_server: {
      endpoint: `${origin}/mcp`,
      transport: "streamable-http",
      protocol_versions: PROTOCOL_VERSIONS,
      tools: TOOLS.map((tool) => tool.name)
    },
    http_api: {
      endpoints: {
        [`${origin}/api`]: "curl_request (also /api/request)",
        [`${origin}/api/json`]: "fetch_json",
        [`${origin}/api/check`]: "check_url",
        [`${origin}/api/batch`]: "batch_request (POST only)"
      },
      input: "POST a JSON object with the MCP tool arguments, or use GET with the scalar arguments as query parameters (url, method, redirect, timeoutMs, maxResponseBytes, fallbackToGet).",
      arguments: Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.inputSchema])),
      response: "JSON. Request results have request and response objects; response.body is UTF-8 text for textual content and base64 otherwise, and response.headers[\"set-cookie\"] is an array.",
      example: `${origin}/api?url=${encodeURIComponent("https://example.com")}`
    }
  };
}
