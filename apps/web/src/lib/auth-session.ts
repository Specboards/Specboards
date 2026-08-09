import { headers } from "next/headers";

import { extractApiKey, verifyApiKey } from "@/lib/api-keys";
import {
  isScopeExemptPath,
  keyScopesSatisfy,
  requiredScopeFor,
} from "@/lib/api-scopes";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { QUOTAS, enforceQuota } from "@/lib/rate-limit";
import type { Database } from "@specboards/db";
import type { ActorRef, WorkspaceScope } from "@/lib/store/types";
import {
  resolveApiMembership,
  type ApiMembershipError,
  type Member,
  type MemberRole,
} from "@/lib/workspace";

export type SessionUser = { id: string; email: string; name: string };

/**
 * The explicit organization an API request is scoped to, or `null` when the
 * caller didn't name one. The browser client sends the active org as the
 * `x-org-slug` header (derived from the `/[org]/…` route); browser navigations
 * that can't set a header (e.g. GitHub redirects) pass `?org=` instead. This
 * is only a hint — {@link resolveApiMembership} validates it against a real
 * membership, so a forged value can at most name an org the caller can't reach.
 */
export function orgSlugFromRequest(req: Request): string | null {
  const header = req.headers.get("x-org-slug")?.trim();
  if (header) return header;
  const url = new URL(req.url);
  const query = url.searchParams.get("org")?.trim();
  return query || null;
}

/** Turn a membership-resolution failure into the API error response. */
function membershipErrorResponse(error: ApiMembershipError): Response {
  switch (error.code) {
    case "org_ambiguous":
      return Response.json(
        {
          error:
            "You belong to more than one organization. Name the one to act in " +
            "with the x-org-slug header (or ?org= for redirects).",
        },
        { status: 400 },
      );
    case "not_a_member":
      return Response.json(
        { error: "You do not have access to that organization." },
        { status: 403 },
      );
    case "no_workspace":
      return Response.json(
        { error: "You do not belong to a workspace." },
        { status: 403 },
      );
  }
}

/**
 * Resolve the caller's validated membership for an API request against the
 * explicit org they named (header/query). Shared by every authorization
 * helper below so the oldest-membership guess lives in exactly zero places.
 */
async function resolveRequestMembership(
  req: Request,
  userId: string,
): Promise<{ ok: true; membership: Member } | { ok: false; response: Response }> {
  const db = getDb()!;
  const result = await resolveApiMembership(db, userId, orgSlugFromRequest(req));
  if (!result.ok) {
    return { ok: false, response: membershipErrorResponse(result.error) };
  }
  return { ok: true, membership: result.membership };
}

/**
 * A resolved API caller: the user behind the request and, when they
 * authenticated with an API key, that key's resource scopes. `scopes` is `[]`
 * for browser-session auth and for legacy full-access keys, both of which are
 * unrestricted.
 */
interface RequestPrincipal {
  user: SessionUser;
  scopes: string[];
  /** True when the caller authenticated with an API key (vs a browser session). */
  viaKey: boolean;
}

/**
 * Describe the caller for the change ledger.
 *
 * An API key is what an MCP agent authenticates with, so a key-authenticated
 * write is attributable to the key's owner and was still not typed by them.
 * Recording only the user id would make every agent edit look like a person
 * sitting at a keyboard, and that cannot be corrected after the fact: it is a
 * property of rows already written.
 */
function actorFor(principal: RequestPrincipal): ActorRef {
  return {
    type: principal.viaKey ? "api_key" : "user",
    id: principal.user.id,
    // Snapshotted at write time; the user may later be renamed or removed.
    label: principal.user.name ?? principal.user.email ?? null,
  };
}

/**
 * Resolve the caller behind an API request from either a CLI API key
 * (`x-api-key` / `Authorization: Bearer sb_…`, checked first) or the browser
 * session cookie. Returns `null` when neither identifies a user. Assumes auth
 * is enabled (DB present); callers handle local file mode separately.
 */
async function resolveRequestUser(req: Request): Promise<RequestPrincipal | null> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return null;

  const rawKey = extractApiKey(req);
  if (rawKey) {
    const verified = await verifyApiKey(db, rawKey);
    return verified
      ? { user: verified.user, scopes: verified.scopes, viaKey: true }
      : null;
  }

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  const { id, email, name } = session.user;
  return { user: { id, email, name }, scopes: [], viaKey: false };
}

/**
 * Enforce a scoped API key against what the request needs. Returns a 403
 * response when the key may not make this request, else `null`. Session auth and
 * legacy full-access keys (empty `scopes`) always pass.
 *
 * Paths with no derivable scope are **denied**, not allowed. Deriving the scope
 * from the URL only covers `/api/v1/<resource>`; treating "no mapping" as "no
 * scope required" meant every other surface accepted a restricted key at full
 * power, which is how a `features:read` key reached the MCP write tools. The
 * surfaces that legitimately have no path-derived scope are named in
 * {@link isScopeExemptPath} and gate themselves (`/api/mcp` scopes per tool).
 */
function enforceKeyScope(req: Request, scopes: string[]): Response | null {
  if (scopes.length === 0) return null;
  const pathname = new URL(req.url).pathname;
  if (isScopeExemptPath(pathname)) return null;
  const required = requiredScopeFor(req.method, pathname);
  if (!required) {
    return Response.json(
      {
        error:
          "API keys cannot be used on this endpoint. Sign in from the browser, " +
          "or use an endpoint under /api/v1 that a key scope can cover.",
      },
      { status: 403 },
    );
  }
  if (keyScopesSatisfy(scopes, required)) return null;
  return Response.json(
    {
      error: `This API key lacks the "${required.resource}:${required.action}" scope.`,
    },
    { status: 403 },
  );
}

/**
 * Enforce API-key policies (scope + per-key rate limit) for a resolved
 * principal. No-op for browser sessions. Returns a ready-to-return error
 * response (403 for a missing scope, 429 when the key's request quota is
 * exhausted), or `null` when the request may proceed.
 */
async function enforceKeyPolicies(
  req: Request,
  principal: RequestPrincipal,
  db: Database,
): Promise<Response | null> {
  if (!principal.viaKey) return null;
  const scopeDenied = enforceKeyScope(req, principal.scopes);
  if (scopeDenied) return scopeDenied;
  return enforceQuota(db, QUOTAS.apiRequest, `key:${principal.user.id}`);
}

/**
 * Outcome of resolving the tenant scope for an API request. `scope` is `null`
 * in local file mode (auth disabled) — callers pass it straight to the store,
 * which ignores it. On denial, `response` is the ready-to-return error.
 */
export type ScopeResult =
  | { ok: true; scope: WorkspaceScope | null }
  | { ok: false; response: Response };

/** Session user resolved from a server component / page request context. */
export async function getServerSessionUser(): Promise<SessionUser | null> {
  const auth = getAuth();
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, email, name } = session.user;
  return { id, email, name };
}

/**
 * The authenticated user for a request, or `null` when there is no session.
 * Returns `null` in local file mode (auth disabled) too — callers that need a
 * user there should treat it as "auth disabled".
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const auth = getAuth();
  if (!auth) return null;
  const resolved = await resolveRequestUser(req);
  return resolved?.user ?? null;
}

/**
 * Resolve the tenant scope for an API request, enforcing authorization.
 *
 * In local file mode (auth disabled) everything is allowed with a `null`
 * scope. Otherwise the caller must have a session and belong to a workspace.
 *
 * Write authorization is now **per product**, not per org role: a member can
 * belong to the org yet only edit the products they've been granted (owner
 * edits everything). So this coarse gate only requires membership; the store
 * enforces `canWriteProduct` on each mutation (see `db.ts` `canWriteProductId`)
 * and rejects a write to a product the caller can't edit. `opts.write` is kept
 * for call-site intent and future use.
 */
async function resolveScope(
  req: Request,
  _opts: { write: boolean },
): Promise<ScopeResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return { ok: true, scope: null };

  const principal = await resolveRequestUser(req);
  if (!principal) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const denied = await enforceKeyPolicies(req, principal, db);
  if (denied) return { ok: false, response: denied };

  const resolved = await resolveRequestMembership(req, principal.user.id);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    scope: {
      userId: principal.user.id,
      workspaceId: resolved.membership.workspaceId,
      actor: actorFor(principal),
    },
  };
}

/** Scope for a read request: requires a workspace member (any role). */
export function resolveReadScope(req: Request): Promise<ScopeResult> {
  return resolveScope(req, { write: false });
}

/**
 * Read access for an API request, including the caller's role (which
 * `resolveReadScope` drops). Used where the response depends on edit rights,
 * e.g. the item-detail context the flyout renders. `null` access is file mode.
 *
 * `credential` describes *how* the caller authenticated. The path-derived scope
 * check has already run, but a surface whose URL does not name its resource
 * (`/api/mcp`) has to do its own check, and it can only do that if it knows the
 * key's grants. `scopes: []` means unrestricted: either a browser session or a
 * legacy full-access key.
 */
export interface CredentialInfo {
  /** True when the caller authenticated with an API key (vs a browser session). */
  viaKey: boolean;
  /** The key's granted scopes; `[]` is unrestricted. */
  scopes: string[];
}

export type ReadAccessResult =
  | {
      ok: true;
      access: (WorkspaceScope & { role: MemberRole }) | null;
      credential: CredentialInfo;
    }
  | { ok: false; response: Response };

export async function resolveReadAccess(req: Request): Promise<ReadAccessResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) {
    return { ok: true, access: null, credential: { viaKey: false, scopes: [] } };
  }

  const principal = await resolveRequestUser(req);
  if (!principal) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const denied = await enforceKeyPolicies(req, principal, db);
  if (denied) return { ok: false, response: denied };
  const resolved = await resolveRequestMembership(req, principal.user.id);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    access: {
      userId: principal.user.id,
      workspaceId: resolved.membership.workspaceId,
      role: resolved.membership.role,
    },
    credential: { viaKey: principal.viaKey, scopes: principal.scopes },
  };
}

/**
 * Scope for a write request: requires workspace membership. Per-product write
 * authorization is enforced downstream by the store (`canWriteProduct`), so a
 * member without a grant on the target product is rejected at the mutation.
 */
export function authorizeWrite(req: Request): Promise<ScopeResult> {
  return resolveScope(req, { write: true });
}

/**
 * Scope for an owner-only action (creating products, managing the org).
 * Local file mode (auth disabled) is ungated with a `null` scope.
 */
export async function authorizeOrgAdmin(req: Request): Promise<ScopeResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return { ok: true, scope: null };

  const principal = await resolveRequestUser(req);
  if (!principal) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const denied = await enforceKeyPolicies(req, principal, db);
  if (denied) return { ok: false, response: denied };
  const resolved = await resolveRequestMembership(req, principal.user.id);
  if (!resolved.ok) return resolved;
  if (resolved.membership.role !== "owner") {
    return {
      ok: false,
      response: Response.json(
        { error: "Only the workspace owner can do this." },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    scope: {
      userId: principal.user.id,
      workspaceId: resolved.membership.workspaceId,
      actor: actorFor(principal),
    },
  };
}
