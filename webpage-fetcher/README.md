# Web reader

Fetch a public URL and return its content as Markdown through MCP or a regular
HTTP API. HTML and document conversion use Cloudflare Workers AI's `toMarkdown`
binding; HTML preparation uses the Workers runtime's `HTMLRewriter`.

Deploy this service in your own account using the [deployment guide](../README.md#deploy):

```sh
# From the repository root, after npm ci and Cloudflare login:
npm run deploy:read
```

Keep the complete repository, including `shared/`, in your checkout. The
maintainer provides source code only. Every endpoint below is a placeholder;
replace it with the URL printed by your own deployment.

## MCP

```text
https://webpage-fetcher.<your-subdomain>.workers.dev/mcp
```

Use Streamable HTTP. The tool is `fetch_webpage_to_markdown` and is annotated
as read-only. The default server has no inbound authentication.

| Argument | Default | Meaning |
|---|---|---|
| `url` | Required | Absolute public HTTP or HTTPS URL |
| `maxLength` | `20000` | Maximum characters in a returned part; from `1000` to `100000` |
| `startIndex` | `0` | Offset for the next part; use the value returned by the tool |
| `selector` | Automatic | CSS selector for HTML, such as `article`, `#content`, or `body` |

Example tool arguments:

```json
{
  "url": "https://developers.cloudflare.com/workers/",
  "maxLength": 20000
}
```

The result begins with the final URL, conversion details, and any notes. When
more content remains, the last line supplies the `startIndex` for the next call.
Offsets use JavaScript string indexing. Each call fetches the source again;
there is no saved document or pagination session.

For HTML, the reader prefers a single article or main content element. A sparse
main element causes the whole cleaned page to be converted instead. An explicit
`selector` lets you choose the part to read; `body` includes the page's wider
content. Selectors apply to HTML conversion.

To connect from ChatGPT, see [Connect to ChatGPT as a plugin](../README.md#connect-to-chatgpt-as-a-plugin).
You can name this plugin `WebRead` or choose another display name.

## HTTP API

Set the origin to your own deployed URL:

```sh
READ_ORIGIN='https://webpage-fetcher.<your-subdomain>.workers.dev'

# Service description
curl --fail-with-body "$READ_ORIGIN/"

# Read a page
curl --fail-with-body --get "$READ_ORIGIN/" \
  --data-urlencode 'url=https://example.com' \
  --data-urlencode 'maxLength=20000'

# Read all cleaned HTML instead of selecting the main content
curl --fail-with-body --get "$READ_ORIGIN/" \
  --data-urlencode 'url=https://example.com' \
  --data-urlencode 'selector=body'
```

`GET /?url=...` accepts the same arguments as the MCP tool. A successful response
has `Content-Type: text/markdown` and pagination headers:

| Header | Meaning |
|---|---|
| `X-Source-URL` | Final URL after redirects |
| `X-Total-Characters` | Total content length |
| `X-Start-Index` | Start of this part |
| `X-End-Index` | End of this part |
| `X-Next-Start-Index` | Present when another part remains |

Errors return JSON with an HTTP error status. `GET /` without a `url` parameter
returns service information.

## Formats and limits

- HTML and XHTML become Markdown. Navigation, scripts, and other page elements
  are removed before conversion.
- Markdown supplied by the destination is read directly. Plain text, JSON, XML,
  and other supported text media types retain their text format.
- Supported documents are PDF, DOCX, XLSX, XLS, XLSM, XLSB, ODT, ODS, and Apple Numbers.
- Page downloads are limited to 4 MiB; longer pages are truncated with a note.
  Document downloads are limited to 10 MiB and fail if larger.
- The fetch deadline is 20 seconds, including body download. Conversion time is
  additional and depends on Workers AI.
- Public HTTP and HTTPS URLs are accepted. URL credentials and local or private
  addresses are rejected.
- Browser JavaScript, account login, browser challenges, image conversion, and
  OCR are outside this service's capabilities. Scanned PDFs can have little text.

Target websites can block requests or impose their own rate limits. Review
copyright and access rules before fetching and reusing content.

## Development and operations

From the repository root:

```sh
npm run dev:read
npm run build:read
```

The `AI` binding has `remote: true`, so HTML and document conversion during
local development requires Cloudflare authorization and an internet connection.
Markdown and plain-text sources are handled directly.

The Worker uses your account's `workers.dev` subdomain by default. Optional
custom domains belong in your own deployment configuration; the examples and
screenshots do not provide an endpoint to use.

HTML and document bytes are sent to Workers AI for conversion. Workers
observability is enabled in the configuration. Review logs, access controls,
and platform quotas before handling sensitive information or sharing the URL.
See [Costs](../README.md#costs) and [SECURITY.md](../SECURITY.md).
