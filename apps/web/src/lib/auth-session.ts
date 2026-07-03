import { headers } from "next/headers";

import { extractApiKey, verifyApiKeyUser } from "@/lib/api-keys";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { WorkspaceScope } from "@/lib/store/types";
import { canWrite, getMembership, type MemberRole } from "@/lib/workspace";

export type SessionUser = { id: string; email: string; name: string };

/**
 * Resolve the user behind an API request from either a CLI API key
 * (`x-api-key` / `Authorization: Bearer sb_…`, checked first) or the browser
 * session cookie. Returns `null` when neither identifies a user. Assumes auth
 * is enabled (DB present); callers handle local file mode separately.
 */
async function resolveRequestUser(req: Request): Promise<SessionUser | null> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return null;

  const rawKey = extractApiKey(req);
  if (rawKey) return verifyApiKeyUser(db, rawKey);

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  const { id, email, name } = session.user;
  return { id, email, name };
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
  return resolveRequestUser(req);
}

/**
 * Resolve the tenant scope for an API request, enforcing authorization.
 *
 * In local file mode (auth disabled) everything is allowed with a `null`
 * scope. Otherwise the caller must have a session and belong to a workspace;
 * write requests additionally require a non-`viewer` role.
 */
async function resolveScope(
  req: Request,
  opts: { write: boolean },
): Promise<ScopeResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return { ok: true, scope: null };

  const user = await resolveRequestUser(req);
  if (!user) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }

  const membership = await getMembership(db, user.id);
  if (!membership) {
    return {
      ok: false,
      response: Response.json(
        { error: "You do not belong to a workspace." },
        { status: 403 },
      ),
    };
  }
  if (opts.write && !canWrite(membership.role)) {
    return {
      ok: false,
      response: Response.json(
        { error: "Your role does not permit this action." },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    scope: { userId: user.id, workspaceId: membership.workspaceId },
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
 */
export type ReadAccessResult =
  | { ok: true; access: (WorkspaceScope & { role: MemberRole }) | null }
  | { ok: false; response: Response };

export async function resolveReadAccess(req: Request): Promise<ReadAccessResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return { ok: true, access: null };

  const user = await resolveRequestUser(req);
  if (!user) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const membership = await getMembership(db, user.id);
  if (!membership) {
    return {
      ok: false,
      response: Response.json(
        { error: "You do not belong to a workspace." },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    access: {
      userId: user.id,
      workspaceId: membership.workspaceId,
      role: membership.role,
    },
  };
}

/** Scope for a write request: requires a member with a non-`viewer` role. */
export function authorizeWrite(req: Request): Promise<ScopeResult> {
  return resolveScope(req, { write: true });
}

/**
 * Scope for an organization-admin action (creating products, managing the org).
 * Local file mode (auth disabled) is ungated with a `null` scope.
 */
export async function authorizeOrgAdmin(req: Request): Promise<ScopeResult> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return { ok: true, scope: null };

  const user = await resolveRequestUser(req);
  if (!user) {
    return {
      ok: false,
      response: Response.json({ error: "Authentication required." }, { status: 401 }),
    };
  }
  const membership = await getMembership(db, user.id);
  if (!membership) {
    return {
      ok: false,
      response: Response.json(
        { error: "You do not belong to a workspace." },
        { status: 403 },
      ),
    };
  }
  if (membership.role !== "admin") {
    return {
      ok: false,
      response: Response.json(
        { error: "Only an organization admin can do this." },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    scope: { userId: user.id, workspaceId: membership.workspaceId },
  };
}
