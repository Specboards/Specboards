import { NextResponse } from "next/server";

import { setNotificationEmailOff } from "@/lib/notification-email";
import { userIdFromUnsubscribeToken } from "@/lib/notifications/unsubscribe";

/**
 * One-click unsubscribe, RFC 8058.
 *
 * This is the URL in the `List-Unsubscribe` header, and the button the mail
 * client draws in its own chrome posts to it with the body
 * `List-Unsubscribe=One-Click`. No session, no page load, no confirmation: the
 * point of the standard is that the reader's client can stop the mail without
 * involving them in a browser at all, and the large mailbox providers now
 * expect bulk senders to honour it. Not honouring it is what turns "unsubscribe
 * me" into "mark as spam", which costs the whole deployment its reputation.
 *
 * The signed token in the query is the authorization. See
 * `notifications/unsubscribe.ts` for its scope, which is this one reversible
 * setting and nothing else.
 *
 * No auth-session import, deliberately: there is no session to read here. That
 * is why this route does not appear in `route-auth.test.ts`'s cookie-only list.
 *
 * Not origin-checked either, and it must not be: this path is listed in
 * `EXEMPT_PREFIXES` in `lib/csrf-origin.ts`.
 *
 * It is listed there because for a long time this comment claimed the exemption
 * and the code did not provide it. The route was origin-checked like any other,
 * and passed only because a mail provider's server-to-server POST carries no
 * `Origin` and an absent `Origin` is allowed. That is true of every provider we
 * know of and it is not a property we control: one of them attaching an
 * `Origin` would have taken one-click unsubscribe with it, and the symptom
 * would have been a slow deliverability decline rather than an error anybody
 * could see. Hence the explicit entry.
 */

/** GET is a person clicking the header link by hand: send them to the page. */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  return NextResponse.redirect(
    new URL(`/unsubscribe?t=${encodeURIComponent(token)}`, request.url),
  );
}

export async function POST(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const userId = userIdFromUnsubscribeToken(token);
  // A bad token is still a 200. There is nobody to tell: the caller is a mail
  // provider's infrastructure, which does nothing useful with a 400 and may
  // hold the failure against the sender. The token either names somebody or it
  // does not, and either way this endpoint has finished.
  if (userId) await setNotificationEmailOff(userId, true);
  return new Response(null, { status: 200 });
}
