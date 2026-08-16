"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** A copyable code snippet with a Copy button and brief "Copied" feedback. */
function CopyBlock({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-stretch gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs">
          {value}
        </pre>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The Model Context Protocol connect panel: shows this deployment's MCP
 * endpoint URL and how to point Claude Code / Claude Desktop at it. Adding
 * the URL is enough: the client discovers OAuth, sends the user through
 * sign-in and consent, and acts as them from then on. A personal API key
 * (Authorization: Bearer sb_...) remains the non-interactive alternative,
 * e.g. for CI. Either way the agent inherits the user's workspace role.
 */
export function McpCard({ endpoint }: { endpoint: string }) {
  const claudeCodeCmd = `claude mcp add --transport http specboards ${endpoint}`;
  const claudeCodeKeyCmd =
    `claude mcp add --transport http specboards ${endpoint} \\\n` +
    `  --header "Authorization: Bearer sb_YOUR_KEY"`;
  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        specboards: {
          type: "http",
          url: endpoint,
        },
      },
    },
    null,
    2,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Context Protocol (MCP)</CardTitle>
        <CardDescription>
          Let coding agents (Claude Code, Claude Desktop) read, review, and
          update your backlog and specs. Agents can list and read items, change
          status and metadata, edit a spec&rsquo;s Markdown (committed to your
          repo), and break a card down into child specs. Add the URL below and
          your client will walk you through signing in, including choosing how
          much access to grant it.{" "}
          <Link
            href="/docs/agents"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Connect your own agent
          </Link>{" "}
          covers the two ways to connect, what each grant allows, worked
          authoring flows, and the request and write limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CopyBlock value={endpoint} label="Endpoint URL" />
        <CopyBlock value={claudeCodeCmd} label="Add it to Claude Code" />
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Claude Desktop config
          </summary>
          <div className="pt-2">
            <CopyBlock value={desktopConfig} label="claude_desktop_config.json" />
          </div>
        </details>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Use an API key instead (non-interactive, e.g. CI)
          </summary>
          <div className="space-y-2 pt-2">
            <CopyBlock value={claudeCodeKeyCmd} label="Claude Code with an API key" />
            <p className="text-xs text-muted-foreground">
              Replace <code className="font-mono">sb_YOUR_KEY</code> with an
              agent&rsquo;s key from the Agents tab. A personal key from the API
              keys tab works too, but it acts as you and inherits everything you
              can do; an agent identity can be granted less and revoked on its
              own.
            </p>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">
          Viewers get read-only access; writes need an editor role or higher.
        </p>
      </CardContent>
    </Card>
  );
}
