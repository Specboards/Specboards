"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Human copy for the OIDC scopes the MCP provider supports. */
const SCOPE_COPY: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without signing in again",
};

/**
 * Approve/deny UI for the OAuth consent page. Posts the decision to Better
 * Auth's consent endpoint (the pending request is identified by the
 * consent_code plus a signed cookie) and follows the redirect it returns,
 * which carries the authorization code (or denial) back to the MCP client.
 */
export function OAuthConsentForm({
  clientName,
  userEmail,
  scopes,
  consentCode,
}: {
  clientName: string;
  userEmail: string;
  scopes: string[];
  consentCode: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(accept: boolean) {
    startTransition(async () => {
      setError(null);
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      if (!res.ok) {
        setError(
          "This authorization request is no longer valid. Go back to your " +
            "MCP client and reconnect to start over.",
        );
        return;
      }
      const { redirectURI } = (await res.json()) as { redirectURI: string };
      window.location.assign(redirectURI);
    });
  }

  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <img src="/brand/specboard-mark.png" alt="Specboard" className="mb-2 h-8 w-8" />
        <CardTitle>Authorize {clientName}</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{clientName}</span> wants to
          access Specboard as {userEmail}. It will act with your role and see the
          same products and specs you can.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {scopes.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5 text-foreground">
                  ·
                </span>
                {SCOPE_COPY[scope] ?? scope}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={pending}
            onClick={() => decide(false)}
          >
            Deny
          </Button>
          <Button
            type="button"
            className="w-full"
            disabled={pending}
            onClick={() => decide(true)}
          >
            {pending ? "…" : "Authorize"}
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Only authorize tools you trust.
        </p>
      </CardContent>
    </Card>
  );
}
