import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth-session";
import { getDb } from "@/lib/db";
import { isMultiTenant } from "@/lib/tenancy";
import { SetupForm } from "@/components/setup-form";
import { ensureMembership, getActiveWorkspace, getMembership } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up · Specboards" };

/**
 * Org onboarding.
 *
 * - **Multi-tenant:** anyone without an org sees the form to create their own;
 *   a user who already belongs to one is bounced to it. (No auto-join — joining
 *   another org is explicit.)
 * - **Single-tenant:** only the very first user sets up; everyone after is
 *   auto-joined to the one workspace and bounced out.
 *
 * Root (`/`) resolves the user's active org and forwards to /{org}/all/backlog.
 */
export default async function SetupPage() {
  const db = getDb();
  if (!db) redirect("/"); // auth disabled (file mode); nothing to set up

  const user = await getServerSessionUser();
  if (!user) redirect("/sign-in?from=/setup");

  if (isMultiTenant()) {
    if (await getMembership(db, user.id)) redirect("/");
  } else if (await getActiveWorkspace(db)) {
    await ensureMembership(db, user.id);
    redirect("/");
  }

  return <SetupForm />;
}
