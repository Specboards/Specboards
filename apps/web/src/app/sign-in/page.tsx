import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";
import { getDb } from "@/lib/db";
import { hasAnyUser } from "@/lib/first-run";

export const metadata = { title: "Sign in · Specboards" };
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  // Nobody can sign in to a deployment with no accounts, and this page is
  // reachable directly (a bookmark, a `?from=` bounce, the link on sign-up), so
  // the redirect belongs here as well as on the root. Otherwise a fresh
  // self-host still has a route to a password form it can never satisfy.
  const db = getDb();
  if (db && !(await hasAnyUser(db))) redirect("/sign-up");

  return (
    <Suspense>
      <AuthForm mode="sign-in" />
    </Suspense>
  );
}
