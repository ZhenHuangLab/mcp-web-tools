# Security

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/ZhenHuangLab/mcp-web-tools/security/advisories/new)
for this repository. Include the affected version, the runtime, steps to
reproduce, and a small example with credentials and personal data removed.
Keep sensitive details out of public issues.

## Deployment responsibilities

The maintainer distributes source code and operates no public or demo endpoints.
You select the Cloudflare account, deploy the Workers, and control their access,
usage, billing, logs, and updates. Documentation endpoints use placeholders.

The default configuration exposes HTTPS endpoints on your account's
`workers.dev` subdomain. The servers have **no inbound authentication**, and
CORS allows all origins. Anyone who can reach an endpoint can call its tools
and HTTP API. A secret-looking URL provides no authentication.

Configure access controls and rate limits suitable for your deployment before
sharing its URLs. Verify that any external authentication layer works with
your MCP client. Interactive browser login pages can block machine clients;
these servers do not implement an OAuth authorization server.

## Outbound requests and agent actions

The HTTP tools support methods that change destination data, including POST,
PUT, PATCH, and DELETE. Their MCP annotations identify them as potentially
destructive. Require user approval for consequential actions and enforce any
needed authorization outside the model's decisions.

Public HTTP and HTTPS URLs are validated. Local and private address checks,
request limits, timeouts, and redirect handling reduce network and resource
risks. The network boundary also depends on Cloudflare Workers and its
`global_fetch_strictly_public` setting. Porting the code to a general-purpose
runtime requires a separate network security review.

When the HTTP tools follow a cross-origin redirect, they remove Authorization
and Cookie headers. Custom credential headers remain subject to the caller's
redirect policy. Use manual or error redirect handling for credentials that
must stay on the original destination. The reader accepts public URLs without
caller-supplied authentication headers.

Treat fetched pages, documents, and API responses as untrusted input. A page's
instructions must not authorize tool use, secret disclosure, or write actions.
Use this software only with destinations and data you are authorized to access.

## Data, secrets, and logs

Requests pass through the deployer's Cloudflare account. The reader sends HTML
and document content to Workers AI for Markdown conversion. Direct Markdown
and plain-text sources are handled by the Worker itself.

Both Wrangler configurations enable observability. Review Cloudflare's logging
and retention settings, including request metadata and error logs. Avoid
putting credentials in URLs, and remove sensitive data from issue reports and
screenshots. Destination headers, bodies, and responses may contain secrets.

Supply deployment credentials through Wrangler's authorization flow, local
environment variables, or a secret store. `.env*` and `.dev.vars*` are ignored
by Git, except explicitly named example files. Keep real credentials out of
source code, examples, prompts, and Git history.

## Resource limits

This project adds no service fee. Cloudflare's quotas, CPU limits, and pricing
apply to your account. Monitor usage, configure rate limits and available
billing controls, and review platform pricing before enabling paid plans.
The application limits each request; it does not enforce an account-wide user
quota or billing limit.
