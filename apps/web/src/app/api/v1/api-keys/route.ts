import { readJsonBody } from "@/lib/api/body";
import { createApiKey, listApiKeys } from "@/lib/api-keys";
import { InvalidScopeError, parseApiScopes } from "@/lib/api-scopes";
import { getAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const NAME_MAX = 80;
const EXPIRES_MAX_DAYS = 3650;

/**
 * Personal API keys are managed with a browser session only (never with another
 * API key): a leaked key must not be able to mint fresh, separately-revocable
 * keys. Resolves the signed-in user from the session cookie, or 401 / 501.
 */
async function sessionUserId(req: Request): Promise<{ id: string } | Response> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) {
    return Response.json(
      { error: "API keys require the database-backed deployment." },
      { status: 501 },
    );
  }
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  return { id: session.user.id };
}

/** GET /api/v1/api-keys — the signed-in user's keys (no secret material). */
export async function GET(req: Request) {
  const who = await sessionUserId(req);
  if (who instanceof Response) return who;
  const keys = await listApiKeys(getDb()!, who.id);
  return Response.json({ keys });
}

/**
 * POST /api/v1/api-keys — create a key. Body: `{ name, expiresInDays? }`.
 * The plaintext `key` is returned exactly once and never stored.
 */
export async function POST(req: Request) {
  const who = await sessionUserId(req);
  if (who instanceof Response) return who;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const record = (body ?? {}) as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return Response.json(
      { error: `A key name (1-${NAME_MAX} chars) is required.` },
      { status: 422 },
    );
  }

  let expiresAt: Date | null = null;
  if (record.expiresInDays != null) {
    const days = Number(record.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > EXPIRES_MAX_DAYS) {
      return Response.json(
        { error: `expiresInDays must be between 1 and ${EXPIRES_MAX_DAYS}.` },
        { status: 422 },
      );
    }
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  let scopes: string[];
  try {
    scopes = parseApiScopes(record.scopes);
  } catch (err) {
    if (err instanceof InvalidScopeError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    throw err;
  }

  const created = await createApiKey(getDb()!, who.id, name, expiresAt, scopes);
  return Response.json({ key: created }, { status: 201 });
}
