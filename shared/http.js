// Helpers for answering inbound requests: CORS, JSON responses, and routing.

// Both services are public and carry no credentials, so every origin is allowed. This also
// satisfies the MCP rule that servers validate the Origin header: no origin can gain access
// that an ordinary client does not already have.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Max-Age": "86400"
};

export function jsonResponse(payload, { status = 200, headers = {}, pretty = false } = {}) {
  return new Response(JSON.stringify(payload, null, pretty ? 2 : undefined), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

export function preflightResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The request path without trailing slashes; "/" for the root. */
export function routePath(url) {
  return url.pathname.replace(/\/+$/, "") || "/";
}
