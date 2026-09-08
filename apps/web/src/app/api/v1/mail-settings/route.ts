import { authorizeOrgAdminBrowserOnly } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  clearMailSettings,
  getMailSettings,
  MailSettingsError,
  parseMailSettingsInput,
  saveMailSettings,
} from "@/lib/mail-settings-service";

export const dynamic = "force-dynamic";

/**
 * This deployment's mail transport.
 *
 * Runs on the owner connection: `mail_settings` is deployment configuration
 * rather than tenant data, carries no `workspace_id` and no RLS, and migration
 * 0004 revokes the tenant role from it outright. See that migration for why a
 * per-workspace version of this table would be a mail-relay hijack waiting to
 * happen on a multi-tenant deployment.
 *
 * Session-only, every verb. An API key is a long-lived credential that can
 * leak into a CI log, and what it would be able to do here is re-point every
 * verification link and invitation this instance sends at a relay of the
 * holder's choosing. That is the same reasoning that makes `model-provider`
 * session-only, one domain over. The read is refused too: a key that can
 * enumerate the transport and sender learns the shape of what it would be
 * attacking, and there is no delegated use for it.
 */

const KEY_REFUSAL =
  "Mail settings can only be changed from a signed-in browser session, not with an API key.";

export async function GET(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(req, KEY_REFUSAL);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db) return Response.json({ error: "No database." }, { status: 503 });
  return Response.json(await getMailSettings(db));
}

export async function PUT(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(req, KEY_REFUSAL);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db) return Response.json({ error: "No database." }, { status: 503 });

  try {
    const input = parseMailSettingsInput(
      await req.json().catch(() => null),
    );
    return Response.json(
      await saveMailSettings(db, input, authz.scope?.userId ?? null),
    );
  } catch (err) {
    if (err instanceof MailSettingsError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(req, KEY_REFUSAL);
  if (!authz.ok) return authz.response;
  const db = getDb();
  if (!db) return Response.json({ error: "No database." }, { status: 503 });
  try {
    return Response.json(await clearMailSettings(db));
  } catch (err) {
    if (err instanceof MailSettingsError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
