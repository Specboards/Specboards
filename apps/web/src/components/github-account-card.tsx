"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Connecting a GitHub account, framed as getting credit for your work.
 *
 * Deliberately not framed as a permissions chore or a setup step. The fallback
 * exists precisely so that people without GitHub accounts are not second-class
 * authors here: their changes still carry their name. So this offers something
 * rather than warning about something missing, and an author who never connects
 * is never told they have failed to do anything.
 */
export function GithubAccountCard({
  connection,
  orgSlug,
}: {
  connection: { githubLogin: string } | null;
  orgSlug: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    startTransition(async () => {
      setError(null);
      const res = await fetch(
        `/api/v1/github/user/connection?org=${encodeURIComponent(orgSlug)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setError("Couldn't disconnect. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub account</CardTitle>
        <CardDescription>
          {connection ? (
            <>
              Spec changes you save are committed as{" "}
              <span className="text-foreground">{connection.githubLogin}</span>,
              so they appear in the repository as your own work.
            </>
          ) : (
            <>
              Connect your GitHub account and the spec changes you save are
              committed as you, rather than by Specboards on your behalf.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connection ? (
          <>
            <Button variant="outline" onClick={disconnect} disabled={pending}>
              {pending ? "…" : "Disconnect"}
            </Button>
            {/* Said plainly. "Disconnected" implying we had revoked the grant
                would be a false assurance about someone's account security. */}
            <p className="text-xs text-muted-foreground">
              Disconnecting removes the connection from Specboards. To withdraw
              access entirely, remove it from your GitHub account settings too.
            </p>
          </>
        ) : (
          <>
            <a
              href={`/api/v1/github/user/connect?org=${encodeURIComponent(orgSlug)}`}
              className={buttonVariants()}
            >
              Connect GitHub
            </a>
            {/* Both halves matter: what it does for them, and that skipping it
                costs them nothing they should worry about. */}
            <p className="text-xs text-muted-foreground">
              Optional. Without it your changes are still recorded under your
              name, they are just committed by Specboards rather than by you.
              Connecting asks GitHub for your identity only, and Specboards can
              still reach only the repositories it already has access to.
            </p>
          </>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
