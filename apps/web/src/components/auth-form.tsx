"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { sendVerificationEmail, signIn, signUp } from "@/lib/auth-client";
import { safeRedirectPath } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

type Mode = "sign-in" | "sign-up";

const copy: Record<
  Mode,
  { title: string; description: string; submit: string; altText: string; altHref: string; altLabel: string }
> = {
  "sign-in": {
    title: "Sign in",
    description: "Welcome back to Specboards.",
    submit: "Sign in",
    altText: "Need an account?",
    altHref: "/sign-up",
    altLabel: "Sign up",
  },
  "sign-up": {
    title: "Create your account",
    description: "Sign up with your work email to get started.",
    submit: "Sign up",
    altText: "Already have an account?",
    altHref: "/sign-in",
    altLabel: "Sign in",
  },
};

/** Email/password sign-in and sign-up form backed by the Better Auth client. */
export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Set once a verification email is in flight: sign-up always lands here (no
  // session until confirmed), and an unverified sign-in falls through to it too.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const t = copy[mode];

  // After auth, return to wherever the user was headed (set by the redirect
  // that bounced them here), defaulting to "/" — the root resolves the user's
  // active org and forwards to /{org}/all/backlog. Sanitized so a crafted `?from=`
  // can't turn the sign-in link into an open redirect.
  const redirectTo = safeRedirectPath(searchParams.get("from"));

  // Carry the post-auth destination across the sign-in ↔ sign-up toggle, so an
  // invited user who lands on /sign-in and switches to /sign-up keeps their
  // `/invite/<token>` callback. Only appended when it's a real path (not "/").
  const altHref =
    redirectTo !== "/"
      ? `${t.altHref}?from=${encodeURIComponent(redirectTo)}`
      : t.altHref;

  // The MCP OAuth authorize endpoint bounces unauthenticated users here with
  // the original OAuth query intact. Resume that flow after sign-in by going
  // back through authorize (same-origin path, so not an open redirect), which
  // then forwards to the consent screen.
  const isOAuthAuthorize =
    searchParams.has("client_id") &&
    searchParams.has("redirect_uri") &&
    searchParams.has("response_type");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "").trim();
    // Only the first person from a company needs this; teammates leave it blank
    // and the server lets them through (see access-gate `isFirstUserForDomain`).
    const signUpCode = String(data.get("signUpCode") ?? "").trim();

    if (mode === "sign-up" && password !== String(data.get("confirmPassword") ?? "")) {
      setError("Passwords don't match.");
      return;
    }

    startTransition(async () => {
      setError(null);
      if (mode === "sign-up") {
        // Send the code in a header rather than the body so it never touches
        // Better Auth's sign-up schema; the auth before-hook reads it.
        const { error } = await signUp.email({
          email,
          password,
          name,
          callbackURL: redirectTo,
          fetchOptions: signUpCode
            ? { headers: { "x-specboards-signup-code": signUpCode } }
            : undefined,
        });
        if (error) {
          setError(error.message ?? "Something went wrong. Please try again.");
          return;
        }
        // requireEmailVerification means no session yet — wait for the link.
        setPendingEmail(email);
        return;
      }

      const { error } = await signIn.email({ email, password, callbackURL: redirectTo });
      if (error) {
        // An unverified address can't sign in; Better Auth re-sends the
        // verification email, so route the user to the "check your email"
        // state. Match the specific code, not a bare 403: other failures also
        // use 403 (e.g. INVALID_ORIGIN when BETTER_AUTH_URL doesn't match the
        // serving domain), and steering those to the verify screen sends the
        // user chasing an email that never comes instead of showing the fault.
        if (error.code === "EMAIL_NOT_VERIFIED") {
          setPendingEmail(email);
          return;
        }
        setError(error.message ?? "Something went wrong. Please try again.");
        return;
      }
      if (isOAuthAuthorize) {
        window.location.assign(`/api/auth/mcp/authorize?${searchParams.toString()}`);
        return;
      }
      router.push(redirectTo);
      router.refresh();
    });
  }

  if (pendingEmail) {
    return (
      <VerifyEmailNotice
        email={pendingEmail}
        redirectTo={redirectTo}
        onBack={() => {
          setPendingEmail(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <img
          src="/brand/specboards-mark.png"
          alt="Specboards"
          className="mb-2 h-8 w-8"
        />
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {mode === "sign-up" ? (
            <FormField
              label="Sign-up code"
              hint="New teams need a sign-up code to get started. If a teammate is already on Specboards, you can leave this blank."
            >
              <Input
                name="signUpCode"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Required to start a new team"
              />
            </FormField>
          ) : null}
          {mode === "sign-up" ? (
            <FormField label="Name">
              <Input name="name" autoComplete="name" required />
            </FormField>
          ) : null}
          <FormField label="Email">
            <Input name="email" type="email" autoComplete="email" required />
          </FormField>
          <FormField
            label="Password"
            labelAside={
              mode === "sign-in" ? (
                <Link
                  href="/forgot-password"
                  className="text-xs font-normal text-link underline underline-offset-4"
                >
                  Forgot password?
                </Link>
              ) : null
            }
          >
            <Input
              name="password"
              type="password"
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              required
            />
          </FormField>
          {mode === "sign-up" ? (
            <FormField label="Confirm password">
              <Input name="confirmPassword" type="password" autoComplete="new-password" required />
            </FormField>
          ) : null}
          <FormError>{error}</FormError>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "…" : t.submit}
          </Button>
        </form>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t.altText}{" "}
          <Link href={altHref} className="text-link underline underline-offset-4">
            {t.altLabel}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Shown after sign-up (or an unverified sign-in) when there's no session yet —
 * the user must click the link in their inbox. Offers a resend affordance.
 */
function VerifyEmailNotice({
  email,
  redirectTo,
  onBack,
}: {
  email: string;
  redirectTo: string;
  onBack: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");

  function resend() {
    startTransition(async () => {
      setStatus("idle");
      const { error } = await sendVerificationEmail({ email, callbackURL: redirectTo });
      setStatus(error ? "error" : "sent");
    });
  }

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <CardTitle>Check your email</CardTitle>
        <CardDescription>
          We sent an email to <span className="text-foreground">{email}</span>. Follow the link in
          it to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" className="w-full" onClick={resend} disabled={pending}>
          {pending ? "…" : "Resend verification email"}
        </Button>
        {status === "sent" ? (
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Sent. Give it a minute, then check your spam folder.
          </p>
        ) : null}
        {status === "error" ? (
          <p className="mt-3 text-center text-xs text-destructive">
            Couldn&apos;t resend just now. Please try again.
          </p>
        ) : null}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Wrong address?{" "}
          <Button
            variant="link"
            size="inline"
            onClick={onBack}
            className="text-xs underline underline-offset-4"
          >
            Go back
          </Button>
        </p>
      </CardContent>
    </Card>
  );
}
