"use client";

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
  const claudeCodeCmd = `claude mcp add --transport http specboard ${endpoint}`;
  const claudeCodeKeyCmd =
    `claude mcp add --transport http specboard ${endpoint} \\\n` +
    `  --header "Authorization: Bearer sb_YOUR_KEY"`;
  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        specboard: {
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
          your client will walk you through signing in; the agent then acts as
          you and inherits your workspace role.
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
              Replace <code className="font-mono">sb_YOUR_KEY</code> with a key
              from the API keys tab.
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
