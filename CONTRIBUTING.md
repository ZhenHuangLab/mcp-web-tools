# Contributing

Issues and pull requests are welcome. For a security concern, follow
[SECURITY.md](SECURITY.md) and report it privately.

## Set up

Use Node.js 22 or later:

```sh
npm ci
npm run check
```

`npm run check` builds both Workers with Wrangler's dry-run deployment mode.
It does not publish code or require Cloudflare account credentials. CI runs
the same command.

Run a service locally with `npm run dev:read` or `npm run dev:curl`. The reader
uses a remote Workers AI binding for HTML and document conversion, including
in local development. Follow the [deployment guide](README.md#deploy) for
Cloudflare authorization and account requirements.

## Make a change

Keep the service-specific logic in its service directory and protocol, HTTP,
validation, and network helpers in `shared/`. A shared change affects both
Workers. Update the corresponding documentation when arguments, output,
limits, or deployment requirements change. Keep README.md and README.zh-CN.md
consistent.

Before submitting, run `npm run check`. For protocol or tool changes, use MCP
Inspector against your own local or deployed endpoint and describe the calls
you checked in the pull request. Verify redirects, limits, and failure behavior
when changing network code.

Use your own Cloudflare account for deployment. Review Worker names first so
you do not update an existing service by mistake. The maintainers provide no
shared testing endpoint.

## Keep examples safe

Use `example.com` and `<your-subdomain>.workers.dev` placeholders for endpoint
examples. Keep personal deployment domains, account IDs, tokens, private URLs,
and local machine paths out of commits. Review screenshots before adding them.

Explain the problem, the change, and the checks performed in a pull request.
Contributions are distributed under the project's [MIT license](LICENSE).
