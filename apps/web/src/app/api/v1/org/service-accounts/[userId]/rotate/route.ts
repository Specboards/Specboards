import { readJsonBody } from "@/lib/api/body";
import { extractApiKey } from "@/lib/api-keys";
import { authorizeOrgAdmin } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  ServiceAccountError,
  parseExpiresInDays,
  rotateServiceAccountKey,
} from "@/lib/service-accounts-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/org/service-accounts/:userId/rotate - replace an agent's key,
 * returning the new plaintext exactly once. Owner-only, session-only.
 *
 * Session-only for the same reason creation is: minting a key must never be
 * reachable with another key, or a leaked owner key could mint itself a fresh,
 * separately-revocable credential that survives revoking the leaked one.
 *
 * The new key keeps the agent's scopes. Expiry is stated per rotation, since
 * only the old key's absolute expiry is stored, not the lifetime it was given.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  if (extractApiKey(req)) {
    return Response.json(
      { error: "Agent keys must be rotated from a signed-in browser session." },
      { status: 403 },
    );
  }

  const authz = await authorizeOrgAdmin(req);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!authz.scope || !db) {
    return Response.json(
      { error: "Service accounts are unavailable in local file mode." },
      { status: 400 },
    );
  }

  // A bodyless rotate is legitimate ("new key, no expiry"), so don't demand
  // JSON just to read one optional field.
  let body: Record<string, unknown> = {};
  if ((req.headers.get("content-length") ?? "0") !== "0") {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return parsed.response;
    body = (parsed.body ?? {}) as Record<string, unknown>;
  }

  // Split from the rotate call below so a bad expiry is a 422 (your input is
  // wrong) rather than the 404 an unknown agent gets.
  let expiresInDays: number | null;
  try {
    expiresInDays = parseExpiresInDays(body.expiresInDays);
  } catch (err) {
    if (err instanceof ServiceAccountError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const { userId } = await params;
  try {
    const key = await rotateServiceAccountKey(
      db,
      authz.scope.workspaceId,
      userId,
      expiresInDays,
    );
    return Response.json({ key }, { status: 201 });
  } catch (err) {
    if (err instanceof ServiceAccountError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
