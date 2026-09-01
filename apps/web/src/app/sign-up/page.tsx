import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";
import { signUpCodeRequired } from "@/lib/access-gate";
import { getDb } from "@/lib/db";
import { hasAnyUser } from "@/lib/first-run";

export const metadata = { title: "Sign up · Specboards" };
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  // Only offer the code field when this deployment actually gates on one.
  // Otherwise a self-hoster's first user, who *is* a new team, reads "Required
  // to start a new team" about a code nobody can issue them and stops there.
  const db = getDb();
  // The very first account on a deployment administers it. Saying so here is
  // the difference between "some sign-up form" and "this is the step setup.sh
  // told me to do", and it is the only moment the fact is actionable.
  const firstRun = db ? !(await hasAnyUser(db)) : false;

  return (
    <Suspense>
      <AuthForm mode="sign-up" showSignUpCode={signUpCodeRequired()} firstRun={firstRun} />
    </Suspense>
  );
}
