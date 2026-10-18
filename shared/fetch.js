// Helpers for outbound requests: URL validation, bounded body reads, media types, and text
// decoding with charset detection.

import { ToolError } from "./schema.js";

/**
 * Parses an absolute public http(s) URL. Workers cannot reach private networks, so this check
 * only gives a clear error message for addresses that could never work.
 */
export function parsePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ToolError(`Invalid URL: ${value}. Pass an absolute URL that starts with http:// or https://.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`Unsupported URL scheme "${url.protocol.slice(0, -1)}". Only http:// and https:// URLs are supported.`);
  }
  if (url.username || url.password) {
    throw new ToolError("Credentials in the URL are not supported. Send them in an Authorization header instead.");
  }
  if (isLocalOrPrivateHost(url.hostname)) {
    throw new ToolError(`${url.hostname} is a local or private address. Only public hosts can be reached.`);
  }
  url.hash = "";
  return url;
}

function isLocalOrPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  if (host.includes(":")) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
        /^fe[89ab]/.test(host) || host.startsWith("ff") || host.startsWith("2001:db8")) {
      return true;
    }
    if (host.startsWith("::ffff:")) {
      const mapped = parseIpv4(host.slice(7));
      return mapped !== null && isPrivateIpv4(mapped);
    }
  }
  return false;
}

function isPrivateIpv4([a, b]) {
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) || a >= 224;
}

function parseIpv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/**
 * HTTP 530 is Cloudflare's own answer when it cannot reach a host at all; the body names the
 * reason, such as "error code: 1016" when the host name does not resolve (HEAD responses have no
 * body). Returns a ToolError for a 530 response, or undefined for any other response.
 */
export async function unreachableHostError(response, url) {
  if (response.status !== 530) return undefined;
  const code = (await response.text()).trim().match(/^error code: (\d+)$/)?.[1];
  const reason = code === "1016"
    ? `the host name ${url.hostname} could not be resolved`
    : `Cloudflare could not reach ${url.hostname} (HTTP 530${code ? `, Cloudflare error ${code}` : ""}). The host name may not resolve, or the host may be down`;
  return new ToolError(`The request failed: ${reason}.`, 502);
}

/** Converts a fetch() rejection into a ToolError. */
export function fetchFailure(error, signal, timeoutMs) {
  if (error instanceof ToolError) return error;
  if (signal.aborted) {
    const seconds = timeoutMs / 1000;
    return new ToolError(`The request timed out after ${seconds} ${seconds === 1 ? "second" : "seconds"}.`, 504);
  }
  return new ToolError(`The request failed: ${error.message}`, 502);
}

const FIRST_READ_BYTES = 64 * 1024;

/**
 * Reads at most maxBytes of a Request or Response body. The rest of the stream is cancelled and
 * `truncated` is set, so an oversized body never has to fit in memory.
 *
 * Network bodies arrive in chunks of about 4 KiB, and reading them one by one costs about 30 µs
 * of CPU each: several milliseconds per page on Cloudflare. A BYOB reader with the `min` option
 * fills large buffers natively instead; the buffers double in size, so a page takes a few reads.
 */
export async function readBody(message, maxBytes) {
  if (!message.body) return { bytes: new Uint8Array(0), truncated: false };

  const reader = message.body.getReader({ mode: "byob" });
  const chunks = [];
  let total = 0;
  let size = FIRST_READ_BYTES;
  try {
    // Read one byte past the limit to detect a body that is too long.
    while (total <= maxBytes) {
      const capacity = Math.min(size, maxBytes + 1 - total);
      const { value, done } = await reader.read(new Uint8Array(capacity), { min: capacity });
      if (value?.byteLength) {
        chunks.push(value);
        total += value.byteLength;
      }
      if (done) break;
      size *= 2;
    }
    if (total > maxBytes) await reader.cancel();
  } finally {
    reader.releaseLock();
  }

  const length = Math.min(total, maxBytes);
  if (chunks.length === 1) return { bytes: chunks[0].subarray(0, length), truncated: total > maxBytes };
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const part = chunk.subarray(0, length - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, truncated: total > maxBytes };
}

/** The lower-case media type of a Content-Type value, without parameters. */
export function mediaTypeOf(contentType) {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function isTextualMediaType(mediaType) {
  return mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("xml") ||
    mediaType.includes("javascript") || mediaType.includes("yaml") || mediaType === "application/x-www-form-urlencoded";
}

/**
 * Decodes text in the order browsers use: byte order mark, then the Content-Type charset, then
 * (for HTML) a <meta> charset declaration, then UTF-8. Workers decode all WHATWG encodings,
 * including GBK, Big5, Shift_JIS, and EUC-KR.
 */
export function decodeText(bytes, contentType, options) {
  return new TextDecoder(textEncoding(bytes, contentType, options)).decode(bytes);
}

/** The canonical name of the text encoding, for example "utf-8" or "gbk", found as decodeText does. */
export function textEncoding(bytes, contentType, { html = false } = {}) {
  const label = bomEncoding(bytes) ?? charsetOf(contentType) ?? (html ? metaCharset(bytes) : undefined) ?? "utf-8";
  try {
    return new TextDecoder(label).encoding;
  } catch {
    // The server named an encoding that does not exist; UTF-8 is the most likely real encoding.
    return "utf-8";
  }
}

function bomEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return undefined;
}

function charsetOf(contentType) {
  return contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
}

function metaCharset(bytes) {
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 4096));
  const label = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1];
  // A UTF-16 declaration found by an ASCII scan is wrong by definition; the HTML standard
  // treats it as UTF-8.
  return label && /^utf-16/i.test(label) ? "utf-8" : label;
}
