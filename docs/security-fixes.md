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

- [ ] Require a non-owner application database role in hosted environments.
- [ ] Fail deployment or startup when the hosted tenant-data connection is an
  owner or has `BYPASSRLS`.
- [ ] Separate authentication, migrations, and background worker duties into
  narrowly scoped database roles.
- [ ] Ensure every tenant-data transaction sets the authenticated user context
  used by RLS before any query is run.
- [ ] Audit direct `getDb()` callers and migrate tenant-data access to the
  scoped store or another RLS-aware repository layer.
- [ ] Add a two-tenant integration suite that proves reads, writes, deletes,
  product visibility, invitations, webhooks, and repository connections cannot
  cross the tenant boundary.

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

- [ ] Include an organization slug or ID in every API request, preferably as a
  route segment such as `/api/v1/orgs/:org/...`.
- [ ] Validate that the caller belongs to the requested organization with
  `resolveActiveWorkspace` or an equivalent explicit membership lookup.
- [ ] Remove the oldest-membership fallback from API authorization.
- [ ] Require an explicit organization for personal API key and MCP requests,
  or issue keys that are scoped to a single organization.
- [ ] Update the client to derive the organization from the current route.
- [ ] Add tests for a user who is an owner in one organization and a read-only
  member in another.

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
  link-local, metadata, private, and internal network ranges.
- [ ] Route outbound webhooks through a proxy or HTTP client that pins the
  connection to the validated address while preserving safe TLS SNI behavior.
- [ ] Reject all non-global addresses using a maintained IP-range parser,
  including IPv4-mapped and hexadecimal IPv6 forms.
- [ ] Retain HTTPS-only targets and `redirect: "manual"`.
- [ ] Add tests for IPv4-mapped IPv6, private AAAA responses, metadata ranges,
  mixed public and private DNS answers, redirect responses, and DNS rebinding
  behavior where practical.

**Acceptance criteria:** A tenant-controlled webhook URL cannot cause traffic
to private or metadata endpoints, even when DNS changes after validation.

## P2: strengthen browser XSS containment

**Risk:** The current Content Security Policy permits inline scripts. The
application does not currently expose an obvious script injection sink, but
this policy provides limited containment if one is introduced later.

**Affected code:**

- `apps/web/next.config.mjs`

**Work items:**

- [ ] Introduce nonce-based CSP for framework bootstrap scripts.
- [ ] Remove `'unsafe-inline'` from `script-src` after the nonce rollout.
- [ ] Evaluate whether inline styles can be removed or narrowed separately.
- [ ] Add an automated header test that asserts production CSP does not permit
  arbitrary inline script execution.

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

- [ ] Move authentication and dynamic-client-registration limits to a shared
  rate-limit store or edge platform control.
- [ ] Set endpoint-specific body-size limits before JSON parsing.
- [ ] Limit MCP JSON-RPC batch length, tool-call concurrency, and total work
  per request.
- [ ] Add per-user and per-workspace quotas for scans, imports, syncs, and
  outbound webhook test deliveries.
- [ ] Apply upstream request limits to the GitHub webhook route before reading
  the raw body.
- [ ] Emit structured security telemetry for rate-limit rejections and repeated
  invalid webhook signatures.

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
