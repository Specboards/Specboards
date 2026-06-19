import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { SetupForm } from "@/components/setup-form";
import { ensureMembership, getActiveWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up · SpecBoard" };

/**
 * Org onboarding. Only the first signed-in user (no workspace yet) sees the
 * form; anyone who already has — or can be auto-joined to — a workspace is
 * bounced to the board.
 */
export default async function SetupPage() {
  const db = getDb();
  if (!db) redirect("/"); // auth disabled (file mode) — nothing to set up

  const user = await getServerSessionUser();
  if (!user) redirect("/sign-in?from=/setup");

  // If an org already exists, this user isn't the first — join it and leave.
  // Root resolves their active org and forwards to /{org}/all/backlog.
  if (await getActiveWorkspace(db)) {
    await ensureMembership(db, user.id);
    redirect("/");
  }

  return <SetupForm />;
}
