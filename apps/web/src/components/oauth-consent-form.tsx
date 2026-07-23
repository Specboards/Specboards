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
import { FormError, FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { signOut } from "@/lib/auth-client";

/** Human copy for the OIDC scopes the MCP provider supports. */
const SCOPE_COPY: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected without signing in again",
};

/** A workspace the signed-in user may authorize the connection for. */
export interface ConsentWorkspace {
  id: string;
  name: string;
  slug: string;
}

/**
 * Sign out and return to the sign-in page. Consent codes are single-use and
 * short-lived, so after signing in as the right account the user re-runs the
 * connection from their MCP client (which is what the client tells them to do).
 */
function SwitchAccountLink() {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOut();
          window.location.assign("/sign-in");
        })
      }
    >
      Not you? Switch account
    </button>
  );
}

/**
 * Shown when the signed-in account belongs to no workspace, so it has nothing to
 * authorize. Rather than mint a token that fails every call with "you do not
 * belong to a workspace", we send the user to a different account.
 */
export function NoWorkspaceNotice({ userEmail }: { userEmail: string }) {
  return (
    <Card className="mx-auto mt-16 w-full max-w-sm">
      <CardHeader>
        <img src="/brand/specboards-mark.png" alt="Specboards" className="mb-2 h-8 w-8" />
        <CardTitle>No workspace to authorize</CardTitle>
        <CardDescription>
          You&rsquo;re signed in as{" "}
          <span className="font-medium text-foreground">{userEmail}</span>, which
          isn&rsquo;t a member of any Specboards workspace. Sign in with the account
          that has access, then reconnect from your MCP client.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-center text-xs text-muted-foreground">
          <SwitchAccountLink />
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Approve/deny UI for the OAuth consent page. Posts the decision to Better
 * Auth's consent endpoint (the pending request is identified by the
 * consent_code plus a signed cookie) and follows the redirect it returns,
 * which carries the authorization code (or denial) back to the MCP client.
 *
 * Before approving, we record which workspace the connection should act in
 * (the sole membership, or the one the user picked), so the MCP resolver can
 * scope requests without the client having to send an `x-org-slug` header.
 */
export function OAuthConsentForm({
  clientName,
  clientId,
  userEmail,
  scopes,
  consentCode,
  workspaces,
}: {
  clientName: string;
  clientId: string;
  userEmail: string;
  scopes: string[];
  consentCode: string;
  workspaces: ConsentWorkspace[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const multiWorkspace = workspaces.length > 1;

  function decide(accept: boolean) {
    startTransition(async () => {
      setError(null);
      // Persist the workspace choice before approving. If this fails we stop
      // rather than mint a token that resolves to the wrong (or no) workspace.
      if (accept && workspaceId) {
        const bind = await fetch("/api/mcp/workspace-binding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, workspaceId }),
        });
        if (!bind.ok) {
          setError("Could not set the workspace for this connection. Try again.");
          return;
        }
      }
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
        <img src="/brand/specboards-mark.png" alt="Specboards" className="mb-2 h-8 w-8" />
        <CardTitle>Authorize {clientName}</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{clientName}</span> wants to
          access Specboards. It will act with your role and see the same products and
          specs you can.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
          <div className="text-muted-foreground">Signed in as</div>
          <div className="font-medium text-foreground">{userEmail}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            <SwitchAccountLink />
          </div>
        </div>

        {multiWorkspace ? (
          <FormField label="Workspace to connect">
            <Select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              disabled={pending}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <div className="text-sm text-muted-foreground">
            Workspace:{" "}
            <span className="font-medium text-foreground">{workspaces[0]?.name}</span>
          </div>
        )}

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
        <FormError>{error}</FormError>
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
