"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { describeStoredGrant } from "@/lib/mcp/connection-grants";

interface ConnectedAgentView {
  clientId: string;
  clientName: string | null;
  workspaceName: string;
  scopes: string[] | null;
  allowDestructive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Date-only options, hoisted so the value is a stable identity rather than a
 * fresh object each render. See {@link LocalTime} for why a timestamp is a
 * component and not a string: formatting one during SSR breaks hydration and
 * takes this card's buttons with it.
 */
const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/**
 * The MCP clients this person has authorized over OAuth: what each was granted,
 * when it last called, and a way to cut it off.
 *
 * Scoped to the signed-in user rather than the workspace, because an OAuth
 * connection acts as a person. Someone else's connection is not the owner's to
 * review here; agent identities, which are the workspace's, live on the Agents
 * tab instead.
 */
export function ConnectedAgentsCard({
  initialConnections,
}: {
  initialConnections: ConnectedAgentView[];
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function revoke(clientId: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/mcp/connections/${encodeURIComponent(clientId)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        setError("Could not disconnect that agent. Try again.");
        return;
      }
      setConnections((prev) => prev.filter((c) => c.clientId !== clientId));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected agents</CardTitle>
        <CardDescription>
          MCP clients you have signed in to Specboards from. Each acts as you,
          limited to what you allowed when you authorized it. Disconnecting one
          stops it on its next call and asks you again next time it connects.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No connected agents"
            description="When you connect a coding agent over OAuth, it appears here with what you granted it."
          />
        ) : (
          <ul className="divide-y rounded-md border">
            {connections.map((c) => (
              <li
                key={c.clientId}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {c.clientName ?? "An MCP agent"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.workspaceName} ·{" "}
                    {describeStoredGrant(c.scopes, c.allowDestructive)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    connected{" "}
                    <LocalTime iso={c.createdAt} options={DATE_ONLY} fallback="never" />{" "}
                    · last used{" "}
                    <LocalTime iso={c.lastUsedAt} options={DATE_ONLY} fallback="never" />
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(c.clientId)}
                  disabled={pending}
                >
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
