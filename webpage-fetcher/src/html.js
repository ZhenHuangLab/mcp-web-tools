// HTML preparation before Markdown conversion, and cleanup of the converted Markdown.

// Elements that never carry readable content. They are removed in every case.
const NON_CONTENT = [
  'script:not([type="application/ld+json"])', "style", "noscript", "template",
  "svg", "canvas", "iframe", "object", "embed"
].join(", ");

// Page chrome and form controls. They are removed only when the main content is chosen
// automatically, so an explicit selector such as "nav" still works.
const PAGE_CHROME = ["nav", '[role="navigation"]', "dialog", "select", "input", "textarea", "[hidden]"].join(", ");

const remove = { element: (element) => element.remove() };

/**
 * Removes noise from a UTF-8 HTML document and finds its content landmarks, in one streaming pass
 * of the native HTMLRewriter (JavaScript runs only for matched elements). Takes and returns bytes,
 * so the page is never copied into a JavaScript string.
 */
export async function prepareHtml(utf8Html, { keepChrome }) {
  const landmarks = { main: 0, roleMain: 0, articles: 0, articlesInMain: 0 };
  let openMains = 0;

  let rewriter = new HTMLRewriter()
    .on(NON_CONTENT, remove)
    .on("main", {
      element(element) {
        landmarks.main += 1;
        openMains += 1;
        element.onEndTag(() => { openMains -= 1; });
      }
    })
    .on('[role="main"]:not(main)', { element() { landmarks.roleMain += 1; } })
    .on("article", {
      element() {
        landmarks.articles += 1;
        if (openMains > 0) landmarks.articlesInMain += 1;
      }
    });
  if (!keepChrome) rewriter = rewriter.on(PAGE_CHROME, remove);

  const source = new Response(utf8Html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const cleaned = new Uint8Array(await rewriter.transform(source).arrayBuffer());
  return { html: cleaned, landmarks };
}

/**
 * Picks the element that holds the main content: a single <article> (when it is the only one, and
 * inside <main> if the page has one), else a single <main>, else a single role="main" element.
 * Returns undefined when the page has no clear main element.
 */
export function mainContentSelector({ main, roleMain, articles, articlesInMain }) {
  if (articles === 1 && (main + roleMain === 0 || articlesInMain === 1)) return "article";
  if (main === 1) return "main";
  if (roleMain === 1) return '[role="main"]';
  return undefined;
}

const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1[`~]*[ \t]*$/gm;

/**
 * Cleans converted Markdown for reading by a language model. Fenced code blocks are left
 * unchanged. Each rule is one global replace over the prose between code blocks, which keeps the
 * CPU cost low on long pages.
 */
export function tidyMarkdown(markdown, pageUrl) {
  const scheme = new URL(pageUrl).protocol;
  let output = "";
  let proseStart = 0;
  for (const match of markdown.matchAll(FENCED_CODE)) {
    output += tidyProse(markdown.slice(proseStart, match.index), scheme) + match[0];
    proseStart = match.index + match[0].length;
  }
  output += tidyProse(markdown.slice(proseStart), scheme);
  return output.trim();
}

function tidyProse(text, scheme) {
  return text
    // The converter copies the document's doctype into its output as text.
    .replace(/^<!doctype[^>]*>$/gim, "")
    // Table rows lose the alignment padding the converter adds (often thousands of characters).
    .replace(/^\|.*$/gm, (row) => {
      const compact = row.replace(/ {2,}/g, " ");
      return /^\|[\s|:-]+$/.test(compact) ? compact.replace(/-{4,}/g, "---") : compact;
    })
    // Links to anchors on the same page become plain text; empty links are removed.
    .replace(/(?<!!)\[([^\]]*)\]\(#[^)]*\)/g, "$1")
    .replace(/(?<!!)\[\]\([^)]*\)/g, "")
    // Protocol-relative links (//host/path) get the page's scheme.
    .replace(/\]\(\/\//g, `](${scheme}//`)
    // Trailing spaces and runs of blank lines are removed.
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** The length of the Markdown text without its YAML front matter. */
export function bodyLength(markdown) {
  const frontMatter = markdown.match(/^---\n[\s\S]*?\n---\n/);
  return markdown.length - (frontMatter ? frontMatter[0].length : 0);
}
