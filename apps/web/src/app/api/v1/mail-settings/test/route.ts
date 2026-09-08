import { authorizeOrgAdminBrowserOnly } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import {
  MailSettingsError,
  parseMailSettingsInput,
  sendTestEmail,
} from "@/lib/mail-settings-service";

export const dynamic = "force-dynamic";

/**
 * Send a test message through the settings being edited.
 *
 * Testing before saving is the point of the button. Mail misconfiguration
 * presents identically to the app being broken, and an admin who has to save a
 * wrong password before finding out it is wrong has already replaced a working
 * configuration with a broken one.
 *
 * The recipient is the acting admin's own address, taken from the session
 * rather than the body. A test send that accepted an arbitrary recipient would
 * be an open relay wearing a Settings page, and there is no reason to test
 * delivery to somebody else's mailbox.
 */
export async function POST(req: Request) {
  const authz = await authorizeOrgAdminBrowserOnly(
    req,
    "Test emails can only be sent from a signed-in browser session, not with an API key.",
  );
  if (!authz.ok) return authz.response;

  const db = getDb();
  if (!db) return Response.json({ error: "No database." }, { status: 503 });

  const { getServerSessionUser } = await import("@/lib/auth-session");
  const user = await getServerSessionUser();
  if (!user?.email) {
    return Response.json(
      { error: "Could not resolve your email address." },
      { status: 400 },
    );
  }

  try {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    // An empty body means "test what is saved"; a body means "test this".
    const input = body?.transport ? parseMailSettingsInput(body) : undefined;
    await sendTestEmail(db, user.email, input);
    return Response.json({ ok: true, to: user.email });
  } catch (err) {
    if (err instanceof MailSettingsError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
