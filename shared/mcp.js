// A small, stateless MCP server endpoint for the Streamable HTTP transport.
//
// It serves both protocol eras from one tool list:
// - 2026-07-28 ("modern"): every request carries its protocol version and client capabilities
//   in params._meta, plus the MCP-Protocol-Version, Mcp-Method, and Mcp-Name headers.
// - 2024-10-07 through 2025-11-25 ("legacy"): initialize handshake, served without sessions.
//
// The validation order and the HTTP status of each rejection follow the reference TypeScript
// SDK (@modelcontextprotocol/server v2). The SDK itself is not used because, measured on
// Cloudflare, it costs 4-23 ms of CPU per request, above the 10 ms limit of the Workers Free
// plan; this module costs well under 1 ms.

import { ToolError, isPlainObject, validateArguments } from "./schema.js";
import { CORS_HEADERS, jsonResponse, preflightResponse } from "./http.js";
import { mediaTypeOf, readBody } from "./fetch.js";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const PROTOCOL_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const TRANSPORT_ERROR = -32000;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

// The tool list is the same for every client and changes only on deployment.
const LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" };

/**
 * Creates the handler for an MCP endpoint.
 *
 * Each tool is `{ name, title, description, annotations, inputSchema, handler }`. The handler
 * receives validated arguments (with schema defaults applied) and `{ env, ctx, request }`, and
 * returns a CallToolResult. A thrown ToolError becomes a tool result with `isError: true`.
 */
export function createMcpEndpoint({ serverInfo, instructions, tools }) {
  const definitions = tools.map(({ handler, ...definition }) => definition);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  async function callTool(id, params, era, context) {
    if (typeof params.name !== "string") {
      return rpcError(id, INVALID_PARAMS, "Invalid params: params.name must be a tool name.", 200);
    }
    const tool = toolsByName.get(params.name);
    if (!tool) {
      const available = [...toolsByName.keys()].join(", ");
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${params.name}. Available tools: ${available}.`, 200);
    }

    let result;
    try {
      const args = validateArguments(tool.inputSchema, params.arguments ?? {});
      result = await tool.handler(args, context);
    } catch (error) {
      result = toolErrorResult(error);
    }
    return rpcResult(id, result, era);
  }

  function handleLegacy(message, params, headerVersion, context) {
    const { id, method } = message;
    if (headerVersion !== undefined && !LEGACY_VERSIONS.includes(headerVersion)) {
      return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", 400, {
        supported: [MODERN_VERSION, ...LEGACY_VERSIONS],
        requested: headerVersion
      });
    }

    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions
        }, "legacy");
      }
      case "ping":
        return rpcResult(id, {}, "legacy");
      case "tools/list":
        return rpcResult(id, { tools: definitions }, "legacy");
      case "tools/call":
        return callTool(id, params, "legacy", context);
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 200);
    }
  }

  function handleModern(message, params, claimedVersion, headers, context) {
    const { id, method } = message;
    if (claimedVersion !== MODERN_VERSION) {
      return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", 400, {
        supported: [MODERN_VERSION],
        requested: claimedVersion
      });
    }

    const headerProblem = standardHeaderProblem(method, params, headers);
    if (headerProblem) return headerMismatch(id, headerProblem);

    switch (method) {
      case "server/discover":
        return rpcResult(id, {
          supportedVersions: [MODERN_VERSION],
          capabilities: { tools: {} },
          instructions,
          ...LIST_CACHE_HINT
        }, "modern");
      case "tools/list":
        return rpcResult(id, { tools: definitions, ...LIST_CACHE_HINT }, "modern");
      case "tools/call":
        return callTool(id, params, "modern", context);
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
    }
  }

  function rpcResult(id, result, era) {
    const body = era === "modern"
      ? { ...result, resultType: "complete", _meta: { [META_SERVER_INFO]: serverInfo } }
      : result;
    return jsonResponse({ jsonrpc: "2.0", id, result: body });
  }

  return async function handleMcpRequest(request, env, ctx) {
    if (request.method === "OPTIONS") return preflightResponse();
    if (request.method !== "POST") {
      // GET and DELETE were 2025-era session operations. This server keeps no sessions.
      return rpcError(null, TRANSPORT_ERROR, "Method not allowed. Send MCP messages with HTTP POST.", 405, undefined, {
        Allow: "POST, OPTIONS"
      });
    }
    if (mediaTypeOf(request.headers.get("content-type")) !== "application/json") {
      return rpcError(null, TRANSPORT_ERROR, "Unsupported Media Type: Content-Type must be application/json.", 415);
    }

    const { bytes, truncated } = await readBody(request, MAX_MESSAGE_BYTES);
    if (truncated) {
      return rpcError(null, TRANSPORT_ERROR, `Payload Too Large: messages are limited to ${MAX_MESSAGE_BYTES} bytes.`, 413);
    }
    let message;
    try {
      message = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return rpcError(null, PARSE_ERROR, "Parse error: the request body is not valid JSON.", 400);
    }

    if (Array.isArray(message)) {
      return rpcError(null, INVALID_REQUEST, "Invalid Request: JSON-RPC batches are not supported. Send one message per POST.", 400);
    }
    if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
      return rpcError(null, INVALID_REQUEST, "Invalid Request: the body is not a JSON-RPC 2.0 message.", 400);
    }
    if (message.method === undefined) {
      // A 2025-era client may post a JSON-RPC response. This server never sends requests, so
      // there is nothing to match it with: acknowledge it and drop it.
      if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        return accepted();
      }
      return rpcError(null, INVALID_REQUEST, "Invalid Request: method is required.", 400);
    }
    if (typeof message.method !== "string") {
      return rpcError(null, INVALID_REQUEST, "Invalid Request: method must be a string.", 400);
    }
    // Notifications need no answer, and no notification changes this server's behavior.
    if (!Object.hasOwn(message, "id")) return accepted();
    if (typeof message.id !== "string" && !Number.isInteger(message.id)) {
      return rpcError(null, INVALID_REQUEST, "Invalid Request: id must be a string or an integer.", 400);
    }
    if (message.params !== undefined && !isPlainObject(message.params)) {
      return rpcError(message.id, INVALID_PARAMS, "Invalid params: params must be an object.", 400);
    }

    const params = message.params ?? {};
    const headers = {
      version: headerValue(request, "mcp-protocol-version"),
      method: headerValue(request, "mcp-method"),
      name: headerValue(request, "mcp-name")
    };
    const meta = isPlainObject(params._meta) ? params._meta : undefined;
    const claimsModernEnvelope = meta !== undefined && Object.hasOwn(meta, META_PROTOCOL_VERSION);
    const context = { env, ctx, request };

    // Era classification. The body decides; the protocol version header is a cross-check.
    if (message.method === "initialize" && !(claimsModernEnvelope && !envelopeProblem(meta) && isModernVersion(meta[META_PROTOCOL_VERSION]))) {
      if (isModernVersion(headers.version)) {
        return headerMismatch(message.id, "an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header.");
      }
      return handleLegacy(message, params, headers.version, context);
    }

    if (claimsModernEnvelope) {
      const problem = envelopeProblem(meta);
      if (problem) {
        return rpcError(message.id, INVALID_PARAMS, `Invalid _meta envelope for protocol revision ${MODERN_VERSION}: ${problem}`, 400);
      }
      const claimedVersion = meta[META_PROTOCOL_VERSION];
      if (headers.version !== undefined && headers.version !== claimedVersion) {
        return headerMismatch(message.id, `the body names protocol version ${claimedVersion} but the MCP-Protocol-Version header names ${headers.version}.`);
      }
      if (headers.method !== undefined && headers.method !== message.method) {
        return headerMismatch(message.id, `the body names method ${message.method} but the Mcp-Method header names ${headers.method}.`);
      }
      return handleModern(message, params, claimedVersion, headers, context);
    }

    if (isModernVersion(headers.version)) {
      return rpcError(message.id, INVALID_PARAMS, `Invalid params: the MCP-Protocol-Version header names ${headers.version}, but params._meta is missing ${META_PROTOCOL_VERSION} and ${META_CLIENT_CAPABILITIES}.`, 400);
    }
    return handleLegacy(message, params, headers.version, context);
  };
}

/** The first problem with a 2026-07-28 request envelope, or undefined when it is valid. */
function envelopeProblem(meta) {
  if (typeof meta[META_PROTOCOL_VERSION] !== "string") return `${META_PROTOCOL_VERSION}: expected a protocol version string.`;
  if (!Object.hasOwn(meta, META_CLIENT_CAPABILITIES)) return `${META_CLIENT_CAPABILITIES}: missing.`;
  if (!isPlainObject(meta[META_CLIENT_CAPABILITIES])) return `${META_CLIENT_CAPABILITIES}: expected an object.`;
  const clientInfo = meta[META_CLIENT_INFO];
  if (clientInfo !== undefined && !(isPlainObject(clientInfo) && typeof clientInfo.name === "string" && typeof clientInfo.version === "string")) {
    return `${META_CLIENT_INFO}: expected an object with string name and version.`;
  }
  return undefined;
}

/** Checks the standard request headers that 2026-07-28 requires (SEP-2243). */
function standardHeaderProblem(method, params, headers) {
  if (headers.version === undefined) return "the required MCP-Protocol-Version header is absent.";
  if (headers.method === undefined) return "the required Mcp-Method header is absent.";
  if (method !== "tools/call" || typeof params.name !== "string") return undefined;

  if (headers.name === undefined) return `the body calls tool ${params.name} but the required Mcp-Name header is absent.`;
  const name = decodeHeaderValue(headers.name);
  if (name === undefined) return "the Mcp-Name header carries an invalid Base64 sentinel value.";
  if (name !== params.name) return `the body calls tool ${params.name} but the Mcp-Name header names ${name}.`;
  return undefined;
}

/** Decodes the `=?base64?...?=` sentinel form of a header value. */
function decodeHeaderValue(value) {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  try {
    const bytes = Uint8Array.fromBase64(value.slice(9, -2));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function headerValue(request, name) {
  return request.headers.get(name)?.trim() ?? undefined;
}

function isModernVersion(version) {
  return typeof version === "string" && version >= MODERN_VERSION;
}

function toolErrorResult(error) {
  if (!(error instanceof ToolError)) console.error("Tool failed:", error);
  const text = error instanceof ToolError ? error.message : `Internal error: ${error.message}`;
  return { isError: true, content: [{ type: "text", text }] };
}

function headerMismatch(id, detail) {
  return rpcError(id, HEADER_MISMATCH, `Bad Request: the request headers and body disagree: ${detail}`, 400);
}

function rpcError(id, code, message, status, data, headers) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return jsonResponse({ jsonrpc: "2.0", id, error }, { status, headers });
}

function accepted() {
  return new Response(null, { status: 202, headers: CORS_HEADERS });
}
