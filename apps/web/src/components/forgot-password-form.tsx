"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { requestPasswordReset } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/**
 * Step one of password reset: collect the email and ask Better Auth to send a
 * reset link. We always show the same "check your inbox" confirmation whether
 * or not the address exists, so the form can't be used to probe for accounts.
 */
export function ForgotPasswordForm() {
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    startTransition(async () => {
      // The link lands on /reset-password (with the token appended by Better Auth).
      await requestPasswordReset({ email, redirectTo: "/reset-password" });
      setSent(true);
    });
  }

  if (sent) {
    return (
      <Card className="mx-auto mt-16 w-full max-w-sm">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If that address has an account, we&apos;ve sent a link to reset your password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-xs text-muted-foreground">
            <Link href="/sign-in" className="text-link underline underline-offset-4">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a link to choose a new password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField label="Email">
            <Input name="email" type="email" autoComplete="email" required />
          </FormField>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "…" : "Send reset link"}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Remembered it?{" "}
          <Link href="/sign-in" className="text-link underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
