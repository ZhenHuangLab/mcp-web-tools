// Text renderings of the curl tool results for language models. Bodies are shown as they are,
// without JSON string escaping, so HTML and JSON stay readable. The REST API returns JSON instead.

const MAX_RESPONSE_BYTES = 1024 * 1024;
// fetch_json shows only the headers an API client acts on: pagination and rate limits.
const API_HEADER = /^(link|retry-after|x-total-count|x-ratelimit-.+|x-rate-limit-.+|ratelimit(-.+)?)$/;

export function formatResponse({ request, response }) {
  const lines = statusLines(request, response);
  lines.push("", "Headers:");
  for (const [name, value] of Object.entries(response.headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  lines.push("", bodySection(response));
  return lines.join("\n");
}

export function formatJson({ request, response }) {
  const lines = statusLines(request, response);
  const apiHeaders = Object.entries(response.headers).filter(([name]) => API_HEADER.test(name));
  if (apiHeaders.length > 0) {
    lines.push("", "Headers:", ...apiHeaders.map(([name, value]) => `${name}: ${value}`));
  }
  lines.push("", "JSON:", JSON.stringify(response.data, null, 2));
  return lines.join("\n");
}

export function formatCheck(check) {
  const lines = [`URL: ${check.url}`];
  if (!check.reachable) {
    lines.push("Reachable: no", `Error: ${check.error}`, `Method: ${check.methodUsed}`, `Time: ${check.elapsedMs} ms`);
    return lines.join("\n");
  }
  lines.push("Reachable: yes", `Status: ${statusText(check.status, check.statusText)}`);
  if (check.redirectsFollowed > 0) lines.push(`Final URL: ${check.finalUrl} (after ${plural(check.redirectsFollowed, "redirect")})`);
  lines.push(`Method: ${check.methodUsed}`, `Time: ${check.elapsedMs} ms`);
  if (check.contentType) lines.push(`Content-Type: ${check.contentType}`);
  if (check.contentLength) lines.push(`Content-Length: ${check.contentLength} bytes`);
  return lines.join("\n");
}

export function formatBatch(batch) {
  const sections = [`${plural(batch.total, "request")}: ${batch.succeeded} completed, ${batch.failed} failed.`];
  for (const item of batch.results) {
    const heading = `=== Request ${item.index + 1} of ${batch.total} ===`;
    sections.push(`${heading}\n${item.completed ? formatResponse(item.result) : `Error: ${item.error}`}`);
  }
  return sections.join("\n\n");
}

function statusLines(request, response) {
  const lines = [`Request: ${request.method} ${request.url}`, `Status: ${statusText(response.status, response.statusText)}`];
  if (request.redirectsFollowed > 0) {
    lines.push(`Final URL: ${response.url} (after ${plural(request.redirectsFollowed, "redirect")})`);
  }
  return lines;
}

function bodySection(response) {
  if (response.bodyBytes === 0) return "Body: empty";
  const details = [`${response.bodyBytes} bytes`];
  if (response.truncated) details[0] = `first ${response.bodyBytes} bytes`;
  if (response.bodyEncoding === "base64") {
    details.push(response.headers["content-type"] ?? "no Content-Type", "base64-encoded");
  }
  let section = `Body (${details.join(", ")}):\n${response.body}`;
  if (response.truncated) {
    section += `\n[The body was cut after ${response.bodyBytes} bytes. Raise maxResponseBytes, up to ${MAX_RESPONSE_BYTES}, to read more.]`;
  }
  return section;
}

function statusText(status, text) {
  return text ? `${status} ${text}` : String(status);
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
