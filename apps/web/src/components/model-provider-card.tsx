"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ModelProviderView {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  credentialHint: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Status = { kind: "ok" | "error"; message: string } | null;

/** Shown under the base URL field so the shape is obvious without docs. */
const EXAMPLES = [
  { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-sonnet-5" },
  { label: "Ollama (self-hosted)", url: "http://localhost:11434/v1", model: "llama3.1" },
];

/**
 * The workspace's model connection, under Integrations beside repositories and
 * webhooks, which is where the product's other outbound connections live.
 *
 * Follows the project convention that adding starts as an affordance: with
 * nothing connected this is a single "Connect a model" button, and the form
 * expands in place only once someone asks for it. Editing an existing
 * connection works the same way, so a configured workspace shows the settings
 * rather than a form sitting open over them.
 *
 * The key is write-only from here. It is sent on save and never returned; the
 * server stores a four-character hint, which is all this renders.
 */
export function ModelProviderCard({
  initialProvider,
  canManage,
}: {
  initialProvider: ModelProviderView | null;
  canManage: boolean;
}) {
  const [provider, setProvider] = useState<ModelProviderView | null>(initialProvider);
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState(initialProvider?.baseUrl ?? "");
  const [model, setModel] = useState(initialProvider?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [testResult, setTestResult] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);

  function openForm() {
    setBaseUrl(provider?.baseUrl ?? "");
    setModel(provider?.model ?? "");
    setApiKey("");
    setStatus(null);
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
    setStatus(null);
  }

  function save() {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/model-provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          model,
          // Only send the key when one was typed. Omitting it means "keep the
          // stored one", so editing the model name does not wipe the credential.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        provider?: ModelProviderView;
        error?: string;
      };
      if (!res.ok || !data.provider) {
        setStatus({ kind: "error", message: data.error ?? "Could not save." });
        return;
      }
      setProvider(data.provider);
      setApiKey("");
      setOpen(false);
      setTestResult(null);
      setStatus({ kind: "ok", message: "Model connection saved." });
    });
  }

  function disconnect() {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/model-provider", { method: "DELETE" });
      if (!res.ok) {
        setStatus({ kind: "error", message: "Could not disconnect." });
        return;
      }
      setProvider(null);
      setTestResult(null);
      setStatus({ kind: "ok", message: "Model disconnected and the key destroyed." });
    });
  }

  /**
   * Runs a real completion. Note this reports `ok: false` on a 200: the request
   * to us succeeded and it is the customer's endpoint that refused, so the
   * message comes from the body rather than the status.
   */
  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/v1/model-provider/test", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reply?: string;
        model?: string | null;
        elapsedMs?: number;
        error?: string;
      };
      if (data.ok) {
        const served = data.model ? ` (served by ${data.model})` : "";
        setTestResult({
          kind: "ok",
          message: `Replied "${data.reply}" in ${data.elapsedMs}ms${served}.`,
        });
      } else {
        setTestResult({
          kind: "error",
          message: data.error ?? "The test call failed.",
        });
      }
    } catch {
      setTestResult({ kind: "error", message: "The test call could not be made." });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model connection</CardTitle>
        <CardDescription>
          Point Specboards at inference you own: an API key for a hosted provider,
          or the base URL of a model you run yourself. Anything speaking the
          OpenAI-compatible API works, which covers the hosted providers as well
          as vLLM, Ollama and most corporate gateways. Your workspace holds the
          vendor relationship and pays for usage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && (
          <p
            className={
              status.kind === "ok"
                ? "text-sm text-muted-foreground"
                : "text-sm text-destructive"
            }
          >
            {status.message}
          </p>
        )}

        {provider && !open && (
          <div className="space-y-3 rounded border p-3">
            <div className="grid gap-1 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Endpoint</span>
                <span className="truncate font-mono text-xs">{provider.baseUrl}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Model</span>
                <span className="font-mono text-xs">{provider.model}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">API key</span>
                <span className="font-mono text-xs">
                  {provider.credentialHint
                    ? `••••${provider.credentialHint}`
                    : "None (endpoint takes no key)"}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Last used</span>
                <span className="text-xs">
                  {provider.lastUsedAt
                    ? new Date(provider.lastUsedAt).toLocaleString()
                    : "Never"}
                </span>
              </div>
            </div>

            {testResult && (
              <p
                className={
                  testResult.kind === "ok"
                    ? "text-sm text-muted-foreground"
                    : "text-sm text-destructive"
                }
              >
                {testResult.message}
              </p>
            )}

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={test} disabled={testing}>
                  {testing ? "Testing…" : "Send a test call"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={openForm}>
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={disconnect}
                  disabled={pending}
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        )}

        {!provider && !open && (
          <EmptyState
            variant="inline"
            title="No model connected"
            description="Connect one to enable the assistant features that need inference."
            action={
              canManage ? (
                <Button type="button" size="sm" onClick={openForm}>
                  Connect a model
                </Button>
              ) : undefined
            }
          />
        )}

        {open && (
          <div className="space-y-3 rounded border p-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-base-url">
                Base URL
              </label>
              <Input
                id="model-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                The API root, ending at the version segment. Examples:{" "}
                {EXAMPLES.map((ex, i) => (
                  <span key={ex.label}>
                    {i > 0 ? ", " : ""}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        setBaseUrl(ex.url);
                        setModel(ex.model);
                      }}
                    >
                      {ex.label}
                    </button>
                  </span>
                ))}
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-name">
                Model
              </label>
              <Input
                id="model-name"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-4o-mini"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Passed to the endpoint exactly as written. A self-hosted runtime
                serves whatever it was started with, so we keep no list.
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-api-key">
                API key
              </label>
              <Input
                id="model-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  provider?.credentialHint
                    ? `Leave blank to keep ••••${provider.credentialHint}`
                    : "Leave blank if the endpoint needs no key"
                }
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Encrypted at rest and never sent back to the browser. A locally
                hosted endpoint usually needs none.
              </p>
            </div>

            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!canManage && (
          <p className="text-xs text-muted-foreground">
            Only the workspace owner can change the model connection.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
