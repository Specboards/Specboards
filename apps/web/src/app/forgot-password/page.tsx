import { Suspense } from "react";

import { ForgotPasswordForm } from "@/components/forgot-password-form";

export const metadata = { title: "Reset password · Specboards" };

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
