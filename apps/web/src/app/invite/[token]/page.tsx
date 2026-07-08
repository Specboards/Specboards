import Link from "next/link";
import { redirect } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ALL_PRODUCTS } from "@/lib/active-product";
import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { redeemInvitation, type RedeemResult } from "@/lib/invitations-service";
import { LOCAL_ORG_SLUG, orgProductPath } from "@/lib/org-path";
import { getWorkspaceById } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accept invitation · Specboard" };

/** A friendly card for the states where redemption can't proceed. */
function InviteProblem({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{body}</p>
        <Link href="/" className={buttonVariants({ variant: "secondary", className: "w-full" })}>
          Go to Specboard
        </Link>
      </CardContent>
    </Card>
  );
}

const PROBLEM_COPY: Record<
  Exclude<RedeemResult, { ok: true }>["reason"],
  { title: string; body: (email?: string, current?: string) => string }
> = {
  not_found: {
    title: "Invitation not found",
    body: () => "This invite link isn't valid. Ask an admin to send you a new one.",
  },
  revoked: {
    title: "Invitation revoked",
    body: () => "This invitation was revoked. Ask an admin to send you a new one.",
  },
  accepted: {
    title: "Already accepted",
    body: () => "This invitation has already been used. You should be able to sign in normally.",
  },
  expired: {
    title: "Invitation expired",
    body: () => "This invitation has expired. Ask an admin to send you a fresh one.",
  },
  email_mismatch: {
    title: "Wrong account",
    body: (email, current) =>
      `This invitation was sent to ${email}, but you're signed in as ${current}. Sign in with ${email} to accept it.`,
  },
};

/**
 * Invitation accept page. Anonymous visitors are bounced to sign-in with a
 * `from` callback (so sign-up → email verify → auto sign-in returns here).
 * A signed-in visitor's token is redeemed and they're dropped into the org;
 * any failure renders a specific, non-crashing message.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const db = getDb();
  if (!db) {
    return (
      <InviteProblem
        title="Invitations unavailable"
        body="This deployment runs in local file mode, which has no accounts to invite."
      />
    );
  }

  const user = await getServerSessionUser();
  if (!user) {
    redirect(`/sign-in?from=${encodeURIComponent(`/invite/${token}`)}`);
  }

  const result = await redeemInvitation(db, token, user);
  if (result.ok) {
    const workspace = await getWorkspaceById(db, result.workspaceId);
    redirect(orgProductPath(workspace?.slug ?? LOCAL_ORG_SLUG, ALL_PRODUCTS, "/backlog"));
  }

  const copy = PROBLEM_COPY[result.reason];
  return <InviteProblem title={copy.title} body={copy.body(result.email, user.email)} />;
}
