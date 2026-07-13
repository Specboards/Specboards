# Specboard: MCP connection auth (identity + workspace binding)

How an MCP client (Claude Code, etc.) authenticates to the hosted Specboard MCP
endpoint, which identity it acts as, and which workspace it targets. Shipped in
**v0.17.0** (feature PR #128, release PR #129, migration `0037`).

## Context

The hosted MCP endpoint lives at `POST /api/mcp` on each deployment
(`app.specboard.ai` for prod, `test.specboard.ai` for test). Both are the same
multi-tenant codebase: several workspaces (orgs) live behind one host, so a
connection has to resolve two separate things on every request:

1. **Identity** - which Specboard user is acting.
2. **Workspace** - which of that user's workspaces the request scopes to.

"Two instances of Specboard" in day-to-day talk (e.g. the Specboard org vs the
Palouse org) are really two **workspaces (tenants) on the same prod host**, not
separate deployments. See [ADR 0001](./adr/0001-multi-tenancy-url-and-product-grouping.md) and
`PLAN-multi-tenant-org-provisioning.md`.

## Two ways to authenticate

`resolveReadAccess` (in `apps/web/src/lib/auth-session.ts`) checks credentials in
this order; the first match wins:

| Method | Header | Bound to | Who it is for |
| --- | --- | --- | --- |
| **API key** | `x-api-key: sb_…` or `Authorization: Bearer sb_…` | the key's user (and their workspace) | service accounts, CI, and identity-split power users |
| **OAuth 2.1** | `Authorization: Bearer <opaque>` | the user who approved consent in the browser | humans (the default, no token typed) |

This is the standard "OAuth for humans, keys for the rest" split (the same shape
as GitHub OAuth vs PATs). For ~95% of users OAuth is the whole story: sign in,
approve, done.

## How identity is bound (OAuth)

The identity is fixed at **consent time**, not in config. When an MCP client
starts the flow it is redirected through `/oauth/consent`
(`apps/web/src/app/oauth/consent/page.tsx`), which reads the current browser
session (`getServerSessionUser()`). Whatever account is signed into the web app
when the user clicks **Authorize** is the account the minted token acts as.

The practical failure this caused (and v0.17.0 fixes): if the browser is signed
into Specboard as a different identity than the one that holds the workspace
membership (e.g. signed in via GitHub as `you@personal.com`, but the workspace
account is `you@company.com`), the token binds to the workspace-less account and
every later tool call fails with "You do not belong to a workspace."

## How the workspace is resolved (`/api/mcp`)

`resolveMcpAuth` (in `apps/web/src/lib/mcp/rpc.ts`) resolves the workspace for an
OAuth-authenticated request in priority order:

1. **`x-org-slug` header**, if the client sends one (explicit override).
2. **The workspace bound at consent time** for this `(userId, clientId)` (see
   below), if no header.
3. **The user's sole membership**, if they belong to exactly one workspace.
4. Otherwise reject: a multi-org user who supplied none of the above gets
   "You belong to more than one organization. Set the x-org-slug header."

Membership is re-validated on every request via `resolveApiMembership`, so a
binding to a workspace the user has since left resolves to no access rather than
silently granting it (fails closed).

## The consent screen (v0.17.0 behavior)

`OAuthConsentForm` / `NoWorkspaceNotice` in
`apps/web/src/components/oauth-consent-form.tsx`:

- **Prominent identity.** Shows "Signed in as {email}" with a "Not you? Switch
  account" link (signs out, returns to `/sign-in`). The bound identity is a
  deliberate confirmation, not fine print.
- **Zero-workspace guard.** If the signed-in account belongs to no workspace,
  the screen shows a switch-account prompt instead of an Authorize button, so a
  dead token is never minted.
- **Workspace picker.** If the user belongs to more than one workspace, they
  pick which one this connection targets. On Authorize the choice is POSTed to
  `POST /api/mcp/workspace-binding` (which re-validates membership) and stored
  before the Better Auth consent call. A single-workspace user gets no picker;
  the binding is still recorded so a header is never needed.

## Data model

Migration `0037` adds `mcp_workspace_bindings`:

| Column | Notes |
| --- | --- |
| `user_id` | FK `users`, cascade |
| `client_id` | FK `oauth_applications.client_id`, cascade |
| `workspace_id` | FK `workspaces`, cascade |
| `created_at` / `updated_at` | |

Unique on `(user_id, client_id)`: one OAuth client, for one user, targets one
workspace. Upserted on re-consent. Read and written through the **owner**
connection (`getDb()`, `DATABASE_URL`), like the other `oauth_*` tables, so it
carries **no RLS** and no app-role grant (it is read during auth resolution,
before any tenant scope exists).

Helpers live in `apps/web/src/lib/mcp/workspace-binding.ts`
(`recordMcpWorkspaceBinding`, `boundWorkspaceSlug`, `consentWorkspaceOptions`).
Integration coverage: `workspace-binding.int.test.ts` (upsert-overwrite + slug
read-back; runs in CI against the Postgres service container).

## Connecting / reconnecting a client

1. Configure the MCP server in your client pointing at `https://app.specboard.ai/api/mcp`.
2. Run the client's connect/auth flow. It opens the browser to Specboard.
3. **Before clicking Authorize, confirm the "Signed in as" email is the account
   that holds the workspace you want.** If not, use "Switch account" and sign in
   as the right one.
4. If you belong to more than one workspace, pick the target on the consent
   screen. You no longer need an `x-org-slug` header for this (the binding
   scopes the connection); the header still works as an override if set.
5. Run `whoami` to confirm the resolved user, workspace, and role.

### Pointing one client at two workspaces

Both workspaces can live on the same host, so the browser can only be one
identity at a time, but each MCP server entry in the client stores its own
credential. To bind two:

- Sign into `app.specboard.ai` as account A, connect server 1, pick workspace A.
- Sign out, sign in as account B, connect server 2, pick workspace B.

The `x-org-slug` header per client entry remains a valid alternative if you want
config-pinned routing (or an API key per entry for fully deterministic,
browser-free binding).

## Related

- [ADR 0001: multi-tenancy](./adr/0001-multi-tenancy-url-and-product-grouping.md)
- `RUNBOOK-github-sync.md` (hosted vs self-host App model)
- Hosted MCP + OAuth 2.1 sign-in first shipped in v0.12.0.
