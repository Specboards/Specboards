# Security fixes backlog

This document records the findings from the July 2026 adversarial source review.
It is an implementation backlog, ordered by security impact. No exploit testing
against a deployed environment was performed.

## P0: prevent GitHub installation binding takeover

**Risk:** A workspace owner can start the GitHub App install flow and replace
the callback's `installation_id` with another real installation of the shared
GitHub App. The CSRF state proves that the browser started an install flow, but
does not prove that the user controls the GitHub account that owns the returned
installation. Once bound, the workspace can list accessible repositories,
connect them, and sync their contents.

**Affected code:**

- `apps/web/src/app/api/v1/github/setup/route.ts`
- `apps/web/src/app/api/v1/github/installations/repositories/route.ts`
- `packages/db/src/schema.ts`

**Work items:**

- [x] Add a GitHub OAuth identity step to the installation flow (setup callback
  now bounces through the App's authorize URL; the new
  `/api/v1/github/oauth/callback` exchanges the code and performs the bind).
- [x] On callback, verify that the authenticated GitHub identity is an owner or
  administrator of the account that owns the installation
  (`packages/git/src/user-oauth.ts`: login match for User accounts,
  active/admin org membership for Organization accounts, everything else
  rejected).
- [x] Bind the OAuth transaction, Specboard session, expected workspace, and
  returned installation account together in a short-lived server-side record
  (`github_install_states`, migration 0035; single-use, 15 minute expiry).
- [x] Do not treat possession of a callback `state` value as proof of GitHub
  account ownership (the state only locates the flow record; binding requires
  the verified identity).
- [x] Alert on `installation_id` bound to multiple workspaces (loud
  `[security]` log on bind; a hard global constraint was skipped on purpose,
  since one GitHub org backing two workspaces is legitimate, and the doc says
  not to rely on it as the control).
- [x] Tests: unit coverage of the ownership checks (wrong user, plain member,
  pending invite, non-member, unknown account type, API failure fails closed)
  and fail-closed E2E tests for forged setup/OAuth callbacks. The full
  malicious-bind path against a second live installation still needs a manual
  smoke test on cloud test.

**Deployment prerequisites (hosted):** generate a client secret on both GitHub
Apps (specboards, specboards-test) and set `GITHUB_APP_CLIENT_ID` /
`GITHUB_APP_CLIENT_SECRET` on the matching Fly apps; add the Callback URL
`https://<host>/api/v1/github/oauth/callback` to each App. Until then,
install-start fails closed with a clear banner. Self-host Apps created from the
manifest flow now store the client secret automatically; pre-existing self-host
Apps need the env vars or a re-run of App setup.

**Acceptance criteria:** A user who is not a verified administrator of the
GitHub installation account cannot bind, enumerate, create repositories in, or
sync from that installation.

## P0: make database tenant isolation fail closed

**Risk:** PostgreSQL row-level security is bypassed when the application uses a
table-owner connection. The tenant store currently falls back to
`DATABASE_URL` when `DATABASE_URL_APP` is unset. A future missing workspace
predicate in an owner-backed query could expose or modify another tenant's data.

**Affected code and infrastructure:**

- `infra/rls-role.sql`
- `apps/web/src/lib/store/index.ts`
- `apps/web/src/lib/db.ts`
- Direct database use in API routes and background workers

**Work items:**

- [x] Require a non-owner application database role in hosted environments:
  `getStore()` now throws instead of falling back to `DATABASE_URL` when
  `SPECBOARD_MULTI_TENANT` is set (single-tenant self-host keeps the
  one-connection path, with a warning).
- [x] Fail deployment or startup when the hosted tenant-data connection is an
  owner or has `BYPASSRLS`: instrumentation boot probe
  (`lib/rls-guard.ts` + `packages/db/src/rls-probe.ts`) verifies the
  `DATABASE_URL_APP` role is non-owner, non-superuser, without `BYPASSRLS`,
  and that RLS is enabled with policies present; a violation refuses startup,
  so platform health checks stop the rollout.
- [ ] Separate authentication, migrations, and background worker duties into
  narrowly scoped database roles. Partially in place (owner for
  auth/migrations/ingestion, `specboard_app` for tenant data); a dedicated
  worker role for the outbox drainer and webhook ingestion is a follow-up.
- [x] Ensure every tenant-data transaction sets the authenticated user context
  used by RLS before any query is run: `DbStore.scoped()` already refuses to
  run without a scope and sets `app.user_id` transaction-locally; the July
  2026 audit confirmed all tenant-data request paths go through it.
- [x] Audit direct `getDb()` callers (82 sites, 2026-07-10): all fall into the
  by-design owner-connection categories (auth/session tables, org membership
  and invitations, API keys, GitHub App config and install binding, webhook
  ingestion, outbox relay) and every one scopes manually. No tenant-data
  request path uses the owner connection.
- [x] Two-tenant integration suite
  (`apps/web/src/lib/store/rls-isolation.int.test.ts`, in CI): cross-tenant
  reads, writes, deletes, product listings, and repository rows cannot cross
  the boundary; an unscoped store call is refused; a context-less connection
  sees zero rows; a workspace-unfiltered query returns only the member's
  tenant; cross-tenant inserts are rejected by policy. Note: invitations and
  webhook tables live on the owner connection by design (no RLS); their
  isolation remains application-enforced and audit-verified.

**Acceptance criteria:** The deployed application cannot connect to tenant
tables with a role that bypasses RLS, and an intentionally unscoped tenant query
fails closed in integration tests.

## P1: make the active organization explicit for all API requests

**Risk:** API authorization resolves the caller's oldest workspace membership.
For a user in multiple organizations, calls made from one organization can read
or mutate another organization where that user also has membership. This is
tenant-context confusion and can produce incorrect authorization decisions.

**Affected code:**

- `apps/web/src/lib/workspace.ts`
- `apps/web/src/lib/auth-session.ts`
- API route handlers under `apps/web/src/app/api/v1`
- API client calls in `apps/web/src/lib/api-client.ts`

**Work items:**

- [x] Include an organization in every API request. Chosen transport is the
  `x-org-slug` request header (not a route segment): the browser client sends
  the active org from the `/[org]/…` route, and browser navigations that can't
  set a header (GitHub install redirects) pass `?org=` instead. Equivalent
  security to a route segment since authority comes from the validated
  membership, with far less churn across ~45 routes.
- [x] Validate that the caller belongs to the requested organization:
  new `resolveApiMembership` (lib/workspace.ts) looks the org up by slug and
  requires a real membership; the three `auth-session.ts` helpers
  (`resolveReadScope`/`resolveReadAccess`/`authorizeWrite` via `resolveScope`,
  and `authorizeOrgAdmin`) all route through it, covering ~44 routes, and the
  ~10 routes that resolved membership by hand were converted too.
- [x] Remove the oldest-membership fallback from API authorization: an
  explicit slug is required for a multi-org caller; naming none is rejected as
  `org_ambiguous` (400) rather than silently pinned. A single-org caller with
  no slug still resolves their sole membership (unambiguous), and single-tenant
  self-host is unchanged.
- [x] Require an explicit org for API-key and MCP requests: both flow through
  the same resolver, so a multi-org key/token must send `x-org-slug` (the CLI
  gained `SPECBOARD_ORG` / `--org` and a config field); the MCP OAuth path was
  switched off `getMembership` too.
- [x] Update the client to derive the org from the current route: `api-client`
  now routes every call through an `apiFetch` wrapper that reads the slug from
  the pathname and sets `x-org-slug`.
- [x] Tests: `workspace-scope.int.test.ts` covers owner-in-A / read-only-in-B
  (pins to the named org with the right role, refuses a non-member org,
  refuses an ambiguous no-slug call, resolves a sole membership). The forged
  GitHub-callback E2E tests were updated for the new safe-redirect behavior.

**Note:** the GitHub `setup` / `oauth/callback` routes now resolve membership
against the install flow's stored (org-validated) workspace instead of the
caller's oldest, so a multi-org owner installs into the org they started from.

**Acceptance criteria:** Every API request has one validated workspace scope,
and a request for organization B cannot read or mutate organization A.

## P1: close webhook SSRF residual risk

**Risk:** The webhook URL guard checks DNS before calling `fetch`. DNS can
change between the validation and the connection, allowing DNS rebinding in
some environments. The guard should also be hardened for non-global IP ranges
and unusual IPv6 representations.

**Affected code:**

- `apps/web/src/lib/webhooks/ssrf.ts`
- `apps/web/src/lib/webhooks/sender.ts`

**Work items:**

- [ ] Enforce egress policy outside the application, blocking loopback,
  link-local, metadata, private, and internal network ranges. (Platform/infra
  task, not code; left open. The app-level defenses below are the in-code
  layer and the acceptance criteria are met without it.)
- [x] Route outbound webhooks through an HTTP client that pins the connection
  to the validated address: the sender resolves + validates once, then hands
  undici an `Agent` whose DNS lookup returns only the pre-validated
  address(es), so the connect never re-resolves (closes DNS rebinding). TLS
  SNI / cert validation still use the original hostname (sender.ts).
- [x] Reject all non-global addresses using a maintained IP-range parser
  (`ipaddr.js`): only global unicast is allowed; IPv4-mapped IPv6 is unwrapped
  and judged as its embedded IPv4 (decimal AND hex notation), and 6to4/Teredo
  are blocked outright (ssrf.ts `isBlockedIp`).
- [x] Retain HTTPS-only targets and `redirect: "manual"` (unchanged).
- [x] Tests (ssrf.test.ts, sender.test.ts): IPv4-mapped IPv6 in decimal + hex,
  the metadata IP mapped in hex, mixed public-A / private-AAAA answers, metadata
  ranges, literal-IP hosts, https-only, and a DNS-rebinding proof (a request to
  an unresolvable hostname still reaches the server via the pinned address).

**Acceptance criteria:** A tenant-controlled webhook URL cannot cause traffic
to private or metadata endpoints, even when DNS changes after validation.

## P2: strengthen browser XSS containment

**Risk:** The current Content Security Policy permits inline scripts. The
application does not currently expose an obvious script injection sink, but
this policy provides limited containment if one is introduced later.

**Affected code:**

- `apps/web/next.config.mjs`

**Work items:**

- [x] Introduce nonce-based CSP: middleware.ts generates a per-request nonce,
  sets it on the request CSP header (so Next tags its bootstrap) and as
  `x-nonce` (read by the layout for next-themes), and emits the CSP on the
  response. Moved off the static `next.config` headers since it's per-request.
- [x] Remove `'unsafe-inline'` from `script-src`: it's now
  `'self' 'nonce-<nonce>' 'strict-dynamic'`, so an injected inline script is
  refused. Verified against a production build in E2E (app still hydrates).
- [ ] Narrow inline styles: `style-src` keeps `'unsafe-inline'` for now
  (Tailwind + inline styles). Left as a separate follow-up; not required to
  contain script injection.
- [x] Automated header test: e2e/security-headers.spec.ts asserts the shipped
  CSP has a nonce, `strict-dynamic`, and no `'unsafe-inline'` in script-src,
  and that the nonce is fresh per response.

**Acceptance criteria:** Production pages use a nonce or equivalent strict CSP
strategy and do not include `'unsafe-inline'` in `script-src`.

## P2: add distributed rate limits and request bounds

**Risk:** Authentication limits are held in process memory and therefore do not
hold across multiple instances. MCP and webhook handlers parse request bodies
without explicit application-level size or batch limits, making inexpensive
resource-exhaustion attempts easier.

**Affected code:**

- `apps/web/src/lib/auth.ts`
- `apps/web/src/app/api/mcp/route.ts`
- `apps/web/src/app/api/webhooks/github/route.ts`
- Expensive repository scan and sync endpoints

**Work items:**

- [x] Move auth + DCR limits to a shared store: Better Auth now uses its
  database rate-limit storage (`rate_limits` table, migration 0036) instead of
  process memory, so the limits hold across instances. No Redis needed.
- [x] Set endpoint-specific body-size limits before parsing: MCP (1 MB) and the
  GitHub webhook (5 MB) check `content-length` and cap the read, returning 413.
- [x] Limit MCP JSON-RPC batch length: batches over 50 messages are rejected
  (413) before any tool runs. (Per-request tool concurrency is bounded by the
  batch cap; finer concurrency limits left as a follow-up.)
- [x] Per-workspace quotas for the expensive endpoints (scan, import,
  starter-spec, repo connect, webhook test): a Postgres fixed-window limiter
  (`lib/rate-limit.ts`, `operation_limits` table) returns 429 + `Retry-After`.
- [x] Bound the GitHub webhook body before reading the raw payload (above).
- [x] Structured security telemetry (`lib/security-log.ts`): `[security:*]`
  lines for rate-limit rejections, oversized/over-batched requests, and invalid
  GitHub webhook signatures (previously a silent 401).

**Acceptance criteria:** Rate limits work consistently across instances and
oversized or excessively batched requests are rejected before expensive parsing
or work begins.

## Validation completed during review

- `pnpm audit --prod --json` completed without reported production dependency
  advisories.
- A committed-secret pattern scan found no obvious private keys or common token
  formats.
- `pnpm test` passed 109 unit tests.

## Recommended delivery sequence

1. Disable or protect the shared GitHub installation binding flow until GitHub
   account ownership is verified.
2. Require the non-owner RLS database role in hosted environments.
3. Introduce explicit organization scoping for REST, API key, and MCP access.
4. Add egress enforcement and SSRF regression tests.
5. Ship request bounds, distributed limits, and CSP hardening.
