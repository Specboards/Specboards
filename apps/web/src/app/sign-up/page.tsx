import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";
import { signUpCodeRequired } from "@/lib/access-gate";

export const metadata = { title: "Sign up · Specboards" };

export default function SignUpPage() {
  // Only offer the code field when this deployment actually gates on one.
  // Otherwise a self-hoster's first user, who *is* a new team, reads "Required
  // to start a new team" about a code nobody can issue them and stops there.
  return (
    <Suspense>
      <AuthForm mode="sign-up" showSignUpCode={signUpCodeRequired()} />
    </Suspense>
  );
}
