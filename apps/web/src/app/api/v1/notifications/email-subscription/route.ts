import { authorizeWrite } from "@/lib/auth-session";
import {
  isNotificationEmailOff,
  setNotificationEmailOff,
} from "@/lib/notification-email";

export const dynamic = "force-dynamic";

/**
 * The master email switch, from inside the app.
 *
 * The unsubscribe link is the way this gets turned off, and it needs no
 * session. This is the other direction: somebody who unsubscribed (or whose
 * mail gateway did it for them) turning it back on from the settings page,
 * where the grid is already telling them why the email column is dead.
 *
 * Acts on the caller and takes no user id, so there is nothing here to
 * delegate sideways. It is a `notifications:write` route like its siblings
 * rather than session-only, because it changes the caller's own notification
 * settings, which is exactly what that scope names.
 */
export async function POST(req: Request) {
  const authz = await authorizeWrite(req);
  if (!authz.ok) return authz.response;
  const userId = authz.scope?.userId;
  if (!userId) {
    return Response.json(
      { error: "There is no account to change here." },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    subscribed?: unknown;
  } | null;
  if (typeof body?.subscribed !== "boolean") {
    return Response.json(
      { error: "`subscribed` must be true or false." },
      { status: 400 },
    );
  }

  await setNotificationEmailOff(userId, !body.subscribed);
  // Read back rather than echo the request. The client renders a state that
  // says whether mail is reaching this person, and it should be the database's
  // answer to that, not ours.
  return Response.json({ subscribed: !(await isNotificationEmailOff(userId)) });
}
