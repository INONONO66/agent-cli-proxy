# Cloudflare External Exposure Plan

This is a design-only plan for safely publishing `agent-cli-proxy` through Cloudflare. It does not add Worker code, change runtime behavior, add dependencies, or alter API/database contracts.

## Goals and non-goals

Goals:

- Keep the origin private while allowing controlled external use of LLM proxy endpoints.
- Separate Cloudflare edge identity, proxy API keys, and admin/dashboard credentials.
- Provide a path for Cloudflare Worker adoption without weakening origin controls.
- Preserve loopback development defaults.

Non-goals:

- Do not make the admin dashboard public by default.
- Do not store provider API keys in this proxy or in a Worker.
- Do not depend on Cloudflare headers unless `TRUST_PROXY_HEADERS=true` is explicitly configured behind Cloudflare.
- Do not implement the Worker in this PR.

## Recommended topology

```text
Client
  |
  | HTTPS + x-proxy-key for /v1/* and /api/*
  v
Cloudflare WAF / rate limits / Access policy
  |
  | optional Worker facade for header policy, CORS, request shaping, and edge telemetry
  v
Access-protected private origin hostname
  |
  | Cloudflare Tunnel via outbound-only cloudflared
  v
agent-cli-proxy bound to 127.0.0.1:3100 or private interface
  |
  v
CLIProxyAPI / provider-side credentials outside this service
```

Cloudflare Tunnel is the preferred origin connectivity layer because the origin does not need inbound public ports. Cloudflare documents Tunnel as an outbound-only connection from `cloudflared` to Cloudflare's network, and public hostnames map to local services such as `http://localhost:8080`.

## Hostname split

Use separate hostnames and policies:

| Hostname | Route target | Audience | Required controls |
| --- | --- | --- | --- |
| `llm.example.com` | Worker facade or path-allowlisted Tunnel route to app origin | API clients | Cloudflare WAF/rate limit, optional Access/service-token policy, mandatory managed `x-proxy-key` at application layer |
| `admin.example.com` | Prefer no public route; if required, Tunnel route to app origin | Operators only | Cloudflare Access user policy, `ADMIN_API_KEY`, dashboard login/session, no shared API-client policy |
| `origin-llm.example.com` | Tunnel route to `http://127.0.0.1:3100` | Worker or Access-authenticated callers only | Cloudflare Access service token policy; do not expose directly to browsers |

If a Worker is used, the public API hostname should point to the Worker and the Worker should forward to the private origin hostname. Avoid pointing the same hostname at both the Worker and Tunnel origin.

## Authentication boundaries

Layer responsibilities:

1. **Cloudflare edge**: WAF, rate limits, bot controls, and optional Cloudflare Access user/service-token policy.
2. **Worker facade, optional**: validate expected edge identity, normalize CORS, reject disallowed methods/paths, strip untrusted forwarding headers, forward only required headers.
3. **Application proxy API key**: every externally reachable LLM proxy request under `/v1/*` and `/api/*` must use a valid managed `x-proxy-key` when `PROXY_REQUIRE_API_KEY=true`. Upstream-style `Authorization` and `x-api-key` headers do not satisfy this application-level key check. This remains separate from Cloudflare Access identity.
4. **Admin credentials**: `/admin/*`, `/dashboard/*`, and `/metrics` use `ADMIN_API_KEY`/dashboard session rules and must not share the API-client proxy key policy.

Cloudflare Access service tokens authenticate automated services with `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. When Access forwards requests to an origin, Cloudflare includes a `Cf-Access-Jwt-Assertion` header; Cloudflare recommends validating that JWT rather than assuming the header is trustworthy in all contexts. A Worker placed behind Access should validate the Access JWT before forwarding privileged requests.

## Tunnel-only path controls

If `llm.example.com` routes directly through Tunnel without a Worker, the public API hostname must still enforce path boundaries before traffic reaches the shared app origin. Configure Cloudflare rules, `cloudflared` ingress, or a local reverse proxy to allow only `/v1/*`, `/api/*`, `/health`, and optionally `/ready`; deny `/admin/*`, `/dashboard/*`, and `/metrics` on the public API hostname. Use a separate operator-only hostname and Access policy if those admin surfaces must be reachable remotely.

Tunnel-only deployments also need provenance-header normalization before enabling `TRUST_PROXY_HEADERS=true`. Strip or overwrite incoming client-supplied `x-forwarded-*`, `forwarded`, `cf-*`, and Access assertion headers with a Cloudflare Transform Rule, Worker, or local reverse proxy before the request reaches the app. If the path cannot guarantee that normalization, keep `TRUST_PROXY_HEADERS=false` until the runtime is changed to prefer trusted Cloudflare headers safely.

## Worker facade design

A future Worker should be small and explicit:

- Allow only the intended public paths: `/v1/*`, `/api/*`, `/health`, and optionally `/ready`.
- Reject `/admin/*`, `/dashboard/*`, and `/metrics` at the Worker unless there is a separate operator-only Worker route.
- Require API clients to provide their own managed `x-proxy-key`; do not mint or hard-code user proxy keys at the edge. Do not treat `Authorization` or `x-api-key` as substitutes for the application proxy key.
- Store only Cloudflare-to-origin credentials, such as an Access service token, as Worker secrets.
- Strip incoming `x-forwarded-*`, `cf-connecting-ip`, `cf-visitor`, and similar provenance headers before creating the origin request; let Cloudflare add trusted values.
- Preserve streaming behavior and avoid buffering SSE responses.
- Use `fetch()` only inside the Worker request handler and forward request bodies as streams where possible.
- Return `cache-control: no-store` for API and auth failures.

Pseudo-flow:

```text
on request:
  if path is not public API/readiness: return 404 or 403
  if public API path and no client proxy API key: return 401 no-store
  validate Access JWT when Worker is behind Access
  clone method, URL path, query, body, and safe headers
  add Cloudflare Access service-token headers for origin hostname
  fetch(origin-llm.example.com, request)
  stream response back without caching
```

## Origin configuration

Recommended origin environment for Cloudflare exposure:

```dotenv
PROXY_HOST=127.0.0.1
PROXY_PORT=3100
PROXY_REQUIRE_API_KEY=true
ADMIN_API_KEY=<long-random-admin-token>
TRUST_PROXY_HEADERS=true # only when requests arrive solely through Cloudflare/Tunnel and provenance headers are stripped/overwritten before origin
```

If the service must bind to `0.0.0.0` for container networking, keep
`PROXY_REQUIRE_API_KEY=true` and keep the container/network firewall restricted
so only `cloudflared` or the private reverse proxy can reach it. Do not publish
the origin port directly to the Internet.

## Header and JWT trust rules

- Treat Cloudflare-provided request headers as trusted only after the network path is constrained to Cloudflare/Tunnel, client-supplied provenance headers are stripped or overwritten before origin, and `TRUST_PROXY_HEADERS=true` is intentionally enabled.
- Do not let clients supply or override `x-forwarded-*`, `forwarded`, `cf-*`, or Access JWT headers through the Worker, Transform Rule, Tunnel-only path, or local reverse proxy.
- If Cloudflare Access is part of the auth boundary, validate `Cf-Access-Jwt-Assertion` using the team domain JWKS and expected audience before relying on identity claims.
- Keep Cloudflare Access identity and app proxy API keys as separate checks: Access proves edge admission; managed `x-proxy-key` provides current app-level usage attribution and provider scoping.
- Do not describe `Authorization` or `x-api-key` as managed proxy-key authorization; public proxy auth is intentionally scoped to `x-proxy-key`.

## Operational controls

- Configure Cloudflare WAF/rate limiting for high-cost LLM endpoints.
- Enable Cloudflare Access logs and Tunnel health notifications.
- Scrape `/metrics` only from an operator-controlled path with `ADMIN_API_KEY`.
- Use the performance baseline script before and after introducing a Worker to confirm no streaming or latency regression.
- Rotate Cloudflare service tokens and proxy API keys independently.
- Keep `.env`, SQLite DB, WAL/SHM, and pricing cache outside deploy replacement directories as covered by the deployment-state follow-up.

## Follow-up implementation tasks

1. Add a minimal Worker template under documentation or examples only, with no new runtime dependency for the proxy package.
2. Add Cloudflare Access JWT validation guidance for any future Worker template.
3. Add deployment examples for Tunnel-only and Worker-plus-Tunnel topologies, including public API path allowlists, admin/dashboard deny rules, and provenance-header strip/overwrite rules.
4. Add a runbook for key rotation, Cloudflare Access policy changes, and rollback to Tunnel-only.

## Decision record

- **Default recommendation**: Tunnel + Access + mandatory proxy API keys, with no Worker unless edge request shaping/CORS/rate-limit logic is needed.
- **Worker recommendation**: use a Worker as a facade, not as the primary secret store or authorization source.
- **Admin recommendation**: keep admin/dashboard private; if exposed, use a separate hostname and Access policy in addition to existing admin auth.

## References

- Cloudflare Tunnel overview: https://developers.cloudflare.com/tunnel/
- Cloudflare Tunnel routing: https://developers.cloudflare.com/tunnel/routing/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Cloudflare Access JWT validation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Cloudflare Workers Fetch API: https://developers.cloudflare.com/workers/runtime-apis/fetch/
