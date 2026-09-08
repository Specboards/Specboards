import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  isNotificationEmailOff,
  setNotificationEmailOff,
} from "@/lib/notification-email";
import { userIdFromUnsubscribeToken } from "@/lib/notifications/unsubscribe";

export const dynamic = "force-dynamic";
export const metadata = { title: "Notification email · Specboards" };

/**
 * The page an unsubscribe link lands on.
 *
 * No session, deliberately. Somebody unsubscribing is in a mail client, quite
 * possibly on a device that has never signed in, and a link that bounces them
 * to a sign-in form is the reason people click "spam" instead. The signed
 * token in the URL is the authorization; see `notifications/unsubscribe.ts`
 * for what it can and cannot do.
 *
 * ── Why the link itself unsubscribes, rather than showing a confirm button ──
 * Because the promise is "one click and it stops". A confirmation step turns
 * that into two, on a page reached by somebody who has already decided. The
 * cost is that a link-scanning mail gateway can trip it by fetching the URL,
 * which is why the state is reversible from this same page in one click and
 * why it affects nothing but notification email.
 *
 * It is not a bare 200 either. It says what was turned off, in those words,
 * and offers both ways back: the whole thing on again, or the per-type grid
 * for somebody who wanted one row quieter rather than all of them.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; resubscribe?: string }>;
}) {
  const { t, resubscribe } = await searchParams;
  const userId = t ? userIdFromUnsubscribeToken(t) : null;

  if (!userId) {
    return (
      <Result
        title="That link is not valid"
        body="This unsubscribe link could not be read. It may have been broken across lines by a mail client. Open Specboards and change your notification settings there instead."
      />
    );
  }

  const turningOff = resubscribe !== "1";
  const known = await setNotificationEmailOff(userId, turningOff);
  if (!known) {
    return (
      <Result
        title="That link is not valid"
        body="This link names an account that no longer exists, so there is nothing to change."
      />
    );
  }

  // Read back rather than assume. This is the one screen where somebody is
  // watching to see whether a thing actually stopped.
  const off = await isNotificationEmailOff(userId);

  return off ? (
    <Result
      title="Notification email is off"
      body="You will not receive any more notification email from Specboards. Notifications still appear in the app, and nothing else about your account has changed."
      // Deliberately not the primary button. The reader has just chosen to
      // stop; drawing the undo as the recommended action would argue with them
      // on the page confirming their own decision.
      action={{
        href: `/unsubscribe?t=${encodeURIComponent(t!)}&resubscribe=1`,
        label: "Turn it back on",
        variant: "secondary",
      }}
      note="If you only wanted one kind of notification to stop, turn it back on and change that row in Settings → Notifications."
    />
  ) : (
    <Result
      title="Notification email is on again"
      body="Specboards will email you about the things your notification settings say it should. You can choose which those are in Settings → Notifications."
      action={{ href: "/", label: "Go to Specboards" }}
    />
  );
}

function Result({
  title,
  body,
  action,
  note,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string; variant?: "default" | "secondary" };
  note?: string;
}) {
  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{body}</p>
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        <Link
          href={action?.href ?? "/"}
          className={buttonVariants({
            variant: action?.variant ?? (action ? "default" : "secondary"),
            className: "w-full",
          })}
        >
          {action?.label ?? "Go to Specboards"}
        </Link>
      </CardContent>
    </Card>
  );
}
