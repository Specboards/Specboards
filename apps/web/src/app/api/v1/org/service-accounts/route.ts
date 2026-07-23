import { readJsonBody } from "@/lib/api/body";
import { extractApiKey } from "@/lib/api-keys";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  ServiceAccountError,
  createServiceAccount,
  listServiceAccounts,
  parseCreateServiceAccountInput,
} from "@/lib/service-accounts-service";

export const dynamic = "force-dynamic";

const FILE_MODE = Response.json(
  { error: "Service accounts are unavailable in local file mode." },
  { status: 400 },
);

/** GET /api/v1/org/service-accounts — the workspace's bot accounts. Owner-only. */
export async function GET(req: Request) {
  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  const accounts = await listServiceAccounts(db, authz.scope.workspaceId);
  return Response.json({ serviceAccounts: accounts });
}

/**
 * POST /api/v1/org/service-accounts — create a bot account and mint its scoped
 * API key (returned exactly once). Owner-only. Session auth only in effect
 * because minting keys via another key is disallowed elsewhere, but here the
 * owner gate plus the org-admin scope is the control.
 */
export async function POST(req: Request) {
  // Minting a key (which this does) must never be reachable with another API
  // key, so a leaked owner key cannot escalate into a fresh, separately-
  // revocable service key. Browser session only, mirroring /api/v1/api-keys.
  if (extractApiKey(req)) {
    return Response.json(
      {
        error:
          "Service accounts must be created from a signed-in browser session.",
      },
      { status: 403 },
    );
  }

  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) return FILE_MODE;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const input = parseCreateServiceAccountInput(body);
    const result = await createServiceAccount(
      db,
      authz.scope.workspaceId,
      input,
      authz.scope,
    );
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceAccountError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }
}
