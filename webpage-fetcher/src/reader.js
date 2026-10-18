// Fetches a URL and turns its content into Markdown.

import { ToolError } from "../../shared/schema.js";
import { decodeText, fetchFailure, isTextualMediaType, mediaTypeOf, parsePublicHttpUrl, readBody, textEncoding, unreachableHostError } from "../../shared/fetch.js";
import { bodyLength, mainContentSelector, prepareHtml, tidyMarkdown } from "./html.js";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// When the automatically chosen main element converts to less text than this, the whole page is
// converted instead: the element was probably a small card, not the main content.
const MIN_MAIN_CONTENT_CHARS = 250;
// A converted page or document with less text than this gets a note about the likely cause.
const SPARSE_TEXT_CHARS = 200;

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  // Sites that publish Markdown, including Cloudflare zones with "Markdown for Agents", return it
  // directly; other sites return HTML.
  "Accept": "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
};

// Document formats that Workers AI converts to Markdown at no cost. Images are not included:
// their conversion runs AI models that use the account's daily Workers AI allowance.
const DOCUMENT_FORMATS = new Map([
  ["application/pdf", { extension: "pdf", label: "PDF document" }],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", { extension: "docx", label: "Word document" }],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { extension: "xlsx", label: "Excel workbook" }],
  ["application/vnd.ms-excel", { extension: "xls", label: "Excel workbook" }],
  ["application/vnd.ms-excel.sheet.macroenabled.12", { extension: "xlsm", label: "Excel workbook" }],
  ["application/vnd.ms-excel.sheet.binary.macroenabled.12", { extension: "xlsb", label: "Excel workbook" }],
  ["application/vnd.oasis.opendocument.text", { extension: "odt", label: "OpenDocument text" }],
  ["application/vnd.oasis.opendocument.spreadsheet", { extension: "ods", label: "OpenDocument spreadsheet" }],
  ["application/vnd.apple.numbers", { extension: "numbers", label: "Numbers spreadsheet" }]
]);
const DOCUMENT_TYPES_BY_EXTENSION = new Map([...DOCUMENT_FORMATS].map(([type, { extension }]) => [extension, type]));

const MAIN_CONTENT_LABELS = {
  article: "the <article> element",
  main: "the <main> element",
  '[role="main"]': 'the element with role="main"'
};

/**
 * Reads a URL and returns `{ url, description, notes, content }`, where `url` is the final URL
 * after redirects, `description` says what the content is and how it was produced, and `content`
 * is the Markdown (or the original text for plain-text formats).
 */
export async function readWebpage({ url, selector }, env) {
  const target = parsePublicHttpUrl(url);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target.href, { headers: REQUEST_HEADERS, redirect: "follow", cache: "no-store", signal });
  } catch (error) {
    throw fetchFailure(error, signal, FETCH_TIMEOUT_MS);
  }
  const pageUrl = response.url || target.href;
  const unreachable = await unreachableHostError(response, new URL(pageUrl));
  if (unreachable) throw unreachable;
  if (!response.ok) {
    await response.body?.cancel();
    throw httpFailure(response, pageUrl);
  }

  const contentType = response.headers.get("content-type");
  const declaredType = declaredMediaType(contentType, pageUrl);
  if (declaredType.startsWith("image/")) {
    await response.body?.cancel();
    throw new ToolError(`${pageUrl} is an image (${declaredType}). This tool reads text and documents only.`, 415);
  }
  if (declaredType && !contentKind(declaredType)) {
    await response.body?.cancel();
    throw new ToolError(`${pageUrl} returned ${declaredType}, which this tool cannot read. It reads HTML, Markdown, plain text, JSON, XML, PDF, and Office documents. Use curl_request to download other content.`, 415);
  }

  // Documents must be read whole; pages are cut at MAX_PAGE_BYTES. An unknown type may be either.
  const mayBeDocument = declaredType === "" || DOCUMENT_FORMATS.has(declaredType);
  const maxBytes = mayBeDocument ? MAX_DOCUMENT_BYTES : MAX_PAGE_BYTES;
  if (mayBeDocument && Number(response.headers.get("content-length")) > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    throw new ToolError(`${pageUrl} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, the most this tool downloads.`, 413);
  }

  let body;
  try {
    body = await readBody(response, maxBytes);
  } catch (error) {
    throw fetchFailure(error, signal, FETCH_TIMEOUT_MS);
  }
  const type = declaredType || sniffMediaType(body.bytes);
  const kind = contentKind(type);
  const notes = [];

  if (kind === "document") {
    if (body.truncated) {
      throw new ToolError(`${pageUrl} is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, the most this tool downloads.`, 413);
    }
    const { extension, label } = DOCUMENT_FORMATS.get(type);
    const markdown = await convertToMarkdown(env, fileName(pageUrl, extension), body.bytes, type, { pdf: { metadata: false } });
    const content = markdown.trim();
    if (bodyLength(content) < SPARSE_TEXT_CHARS) {
      notes.push("The document has very little text. It may consist of scanned images, which this tool does not read.");
    }
    return { url: pageUrl, description: `${label} converted to Markdown`, notes, content };
  }

  if (body.truncated) notes.push(`Only the first ${MAX_PAGE_BYTES / 1024 / 1024} MB of the page were downloaded; the rest is missing.`);

  if (kind === "markdown") {
    const text = decodeText(body.bytes, contentType);
    return { url: pageUrl, description: "Markdown published by the site", notes, content: tidyMarkdown(text, pageUrl) };
  }
  if (kind === "text") {
    const text = decodeText(body.bytes, contentType);
    return { url: pageUrl, description: `${type}, returned as-is`, notes, content: text.trim() };
  }

  // The converter reads UTF-8 only and ignores declared charsets, so other encodings (GBK, Big5,
  // Shift_JIS, ...) are transcoded first. UTF-8 pages are passed on as bytes, without a copy.
  const encoding = textEncoding(body.bytes, contentType, { html: true });
  const utf8Html = encoding === "utf-8" ? body.bytes : new TextEncoder().encode(new TextDecoder(encoding).decode(body.bytes));
  const { markdown, extracted } = await htmlToMarkdown(utf8Html, pageUrl, selector, env);
  let description = "HTML converted to Markdown";
  if (selector !== undefined) description += `; only elements matching the selector ${JSON.stringify(selector)}`;
  else if (extracted) description += `; main content only (${MAIN_CONTENT_LABELS[extracted]}). Pass selector "body" to read the whole page`;
  const content = tidyMarkdown(markdown, pageUrl);
  if (bodyLength(content) < SPARSE_TEXT_CHARS) {
    notes.push(selector !== undefined
      ? `The selector ${JSON.stringify(selector)} matched little or no text.`
      : "The page has very little text. It may build its content with JavaScript, which this tool does not run, or it may have blocked the request.");
  }
  return { url: pageUrl, description, notes, content };
}

/** Splits content into parts of at most maxLength characters, preferring paragraph breaks. */
export function paginate(content, startIndex, maxLength) {
  const total = content.length;
  if (startIndex > 0 && startIndex >= total) {
    throw new ToolError(`startIndex ${startIndex} is past the end of the content, which has ${total} characters.`);
  }
  let end = Math.min(startIndex + maxLength, total);
  if (end < total) {
    const earliest = startIndex + Math.floor(maxLength * 0.8);
    const paragraph = content.lastIndexOf("\n\n", end);
    const line = content.lastIndexOf("\n", end);
    if (paragraph >= earliest) end = paragraph;
    else if (line >= earliest) end = line;
    else if (/[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
  }
  return { text: content.slice(startIndex, end).trim(), start: startIndex, end, total };
}

async function htmlToMarkdown(utf8Html, pageUrl, selector, env) {
  const { html: cleaned, landmarks } = await prepareHtml(utf8Html, { keepChrome: selector !== undefined });
  const name = fileName(pageUrl, "html");
  const convert = (cssSelector) => convertToMarkdown(env, name, cleaned, "text/html", {
    html: cssSelector === undefined ? { hostname: pageUrl } : { hostname: pageUrl, cssSelector }
  });

  if (selector !== undefined) return { markdown: await convert(selector), extracted: undefined };

  const mainSelector = mainContentSelector(landmarks);
  if (mainSelector) {
    const markdown = await convert(mainSelector);
    if (bodyLength(markdown) >= MIN_MAIN_CONTENT_CHARS) return { markdown, extracted: mainSelector };
  }
  return { markdown: await convert(undefined), extracted: undefined };
}

async function convertToMarkdown(env, name, data, type, conversionOptions) {
  let result;
  try {
    [result] = await env.AI.toMarkdown([{ name, blob: new Blob([data], { type }) }], { conversionOptions });
  } catch (error) {
    throw new ToolError(`Markdown conversion failed: ${error.message}`, 502);
  }
  if (result?.format !== "markdown" || typeof result.data !== "string") {
    throw new ToolError(`Markdown conversion failed: ${result?.error ?? "the converter returned no Markdown."}`, 502);
  }
  return result.data;
}

function contentKind(type) {
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (DOCUMENT_FORMATS.has(type)) return "document";
  if (isTextualMediaType(type)) return "text";
  return undefined;
}

/**
 * The media type from Content-Type. A missing or generic binary type is replaced by the type that
 * matches the URL's file extension, or by "" when the content must be sniffed.
 */
function declaredMediaType(contentType, pageUrl) {
  const type = mediaTypeOf(contentType);
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return type;
  const extension = new URL(pageUrl).pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  return DOCUMENT_TYPES_BY_EXTENSION.get(extension) ?? "";
}

function sniffMediaType(bytes) {
  const start = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart();
  if (start.startsWith("%PDF-")) return "application/pdf";
  if (start.startsWith("<")) return "text/html";
  return "text/plain";
}

function fileName(pageUrl, extension) {
  const segment = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    name = segment;
  }
  name ||= "index";
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function httpFailure(response, pageUrl) {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  let message;
  if (response.headers.get("cf-mitigated") === "challenge") {
    message = `The site answered with a Cloudflare bot challenge (${status}). This tool cannot pass browser challenges.`;
  } else if (response.status === 401 || response.status === 403) {
    message = `The site refused the request (${status}). The page may require signing in, or the site may block automated clients.`;
  } else if (response.status === 404 || response.status === 410) {
    message = `The page was not found (${status}). Check the URL.`;
  } else if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    message = `The site is limiting the request rate (${status}).${retryAfter ? ` It asks to retry after ${retryAfter} seconds.` : ""}`;
  } else if (response.status >= 500) {
    message = `The site returned a server error (${status}). Try again later.`;
  } else {
    message = `The site returned ${status}.`;
  }
  return new ToolError(`${message} URL: ${pageUrl}`, response.status >= 500 ? 502 : response.status);
}
