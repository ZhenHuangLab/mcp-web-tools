# HTTP tools

Send HTTP requests from Cloudflare Workers and inspect the live response.
Available through Streamable HTTP MCP and a regular JSON HTTP API.

Deploy this service in your own account using the [deployment guide](../README.md#deploy):

```sh
# From the repository root, after npm ci and Cloudflare login:
npm run deploy:curl
```

Keep the complete repository, including `shared/`, in your checkout. This Worker
uses the Workers runtime directly and needs no Workers AI binding or external
API key. The maintainer provides no public endpoint. Every endpoint below is a
placeholder for your own deployment.

## MCP

```text
https://public-curl-worker.<your-subdomain>.workers.dev/mcp
```

Use Streamable HTTP. The default server has no inbound authentication.

| Tool | Result |
|---|---|
| `curl_request` | Status, final URL, response headers, and text or base64 body |
| `fetch_json` | Parsed JSON with status, final URL, and relevant API headers |
| `check_url` | Reachability, status, final URL, redirect count, and timing |
| `batch_request` | Up to five independent HTTP requests, returned in input order |

`curl_request`, `fetch_json`, and `batch_request` allow write methods and are
annotated as potentially destructive. Review actions before allowing an agent
to send them. `check_url` is annotated as read-only.

To connect from ChatGPT, see [Connect to ChatGPT as a plugin](../README.md#connect-to-chatgpt-as-a-plugin).
You can use `Curl` as the plugin's display name.

## Request arguments

`curl_request` and `fetch_json` accept:

| Argument | Default | Meaning |
|---|---|---|
| `url` | Required | Absolute public HTTP or HTTPS URL |
| `method` | `GET` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, or `OPTIONS` |
| `headers` | Empty | Object of header names and string values |
| `body` | Unset | UTF-8 string, at most 1 MiB; allowed with methods other than GET and HEAD |
| `redirect` | `follow` | `follow`, `manual`, or `error`; follow handles up to five redirects |
| `timeoutMs` | `15000` | Whole request deadline, including redirects and body read; from `1000` to `30000` ms |
| `maxResponseBytes` | `262144` | Returned body limit; from `1024` to `1048576` bytes |

Example tool arguments for a JSON API:

```json
{
  "url": "https://api.github.com/repos/cloudflare/workers-sdk",
  "headers": { "Accept": "application/json" }
}
```

Serialize a JSON request body to a string and set `Content-Type` yourself when
sending JSON. Runtime-managed headers such as Host and Content-Length are
rejected. A User-Agent identifying this repository is added when you omit one.

When following a redirect to a different origin, Authorization and Cookie
headers are removed. Other custom credential headers can still be forwarded;
use `redirect: "manual"` or `"error"` when forwarding them would be unsafe.

Non-2xx statuses are normal response results, so inspect the status.
`fetch_json` adds `Accept: application/json` if absent and fails if the response
is invalid JSON, binary, or truncated. `curl_request` returns truncated bodies
with a flag; text is decoded, and binary data is base64-encoded.

### Check a URL

`check_url` accepts `url`, `headers`, `redirect`, `timeoutMs`, and
`fallbackToGet` (default `true`). It sends HEAD, then retries with GET if the
destination returns 405 or 501. Each attempt has its own timeout.

Reachability describes whether a response was received, including an HTTP
error response. Network failures and timeouts return `reachable: false` with an
error description.

### Batch requests

`batch_request` accepts `requests`, an array of one to five request objects,
and `maxConcurrency`, from one to three (default three). Each item's response
limit defaults to 65536 bytes and can be at most 262144 bytes. Other arguments
match `curl_request`. Individual failures leave the other results available.

## HTTP API

| Endpoint | Methods | Operation |
|---|---|---|
| `/` | GET | Service description |
| `/api` or `/api/request` | GET, POST | `curl_request` |
| `/api/json` | GET, POST | `fetch_json` |
| `/api/check` | GET, POST | `check_url` |
| `/api/batch` | POST | `batch_request` |

POST accepts an `application/json` object with the tool arguments. GET accepts
scalar query arguments such as `url`, `method`, and `timeoutMs`. Use POST for
objects such as `headers` and for batch requests. The API request body is
limited to 2 MiB.

Set the origin to the actual URL printed by your deployment:

```sh
CURL_ORIGIN='https://public-curl-worker.<your-subdomain>.workers.dev'

# Fetch a JSON API
curl --fail-with-body --get "$CURL_ORIGIN/api/json" \
  --data-urlencode 'url=https://api.github.com/repos/cloudflare/workers-sdk'

# Check a public URL
curl --fail-with-body --get "$CURL_ORIGIN/api/check" \
  --data-urlencode 'url=https://example.com'

# Send a request with a custom response limit
curl --fail-with-body "$CURL_ORIGIN/api" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://example.com","method":"GET","maxResponseBytes":65536}'
```

For request results, the returned JSON includes `request` and `response`.
The response contains status, final URL, headers, body encoding, and body
size or truncation details. `fetch_json` returns parsed `data` instead of a
body string. Set-Cookie headers are represented as an array.

## Development and security

From the repository root:

```sh
npm run dev:curl
npm run build:curl
```

Only public HTTP and HTTPS destinations are accepted. Local and private
addresses, URL credentials, and connection-level request headers are rejected.
The public-network restrictions also rely on the Cloudflare Workers runtime;
review network controls before porting this code to another runtime.

This is an outbound request service. Anyone who can reach the default Worker
can make requests and consume your quota. Protect access and apply rate limits
before sharing it. Credentials supplied for a destination pass through your
Worker and Cloudflare; review logs and trust the deployed code. Use only
credentials and target services that you are authorized to access.

See [SECURITY.md](../SECURITY.md) and [Costs](../README.md#costs) for operational
requirements and platform limits.
