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
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

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

/** Something to tell the user, and how loudly. */
type Notice = { kind: "ok" | "error"; message: string } | null;

/**
 * The providers worth naming, plus the escape hatch that covers everything
 * else. Naming them is not vendor favouritism: it removes the single most
 * common setup failure, which is a base URL missing or doubling the version
 * segment. Anything not on this list still works through "Self-hosted".
 */
const PROVIDERS = [
  {
    key: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyless: false,
    hint: "Your key from platform.openai.com. Usage is billed to your account.",
  },
  {
    key: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyless: false,
    hint: "Your key from console.anthropic.com. Usage is billed to your account.",
  },
  {
    key: "custom",
    label: "Self-hosted or other (OpenAI-compatible)",
    baseUrl: "",
    keyless: true,
    hint: "vLLM, Ollama, LM Studio, or a gateway in front of your own weights.",
  },
] as const;

type ProviderKey = (typeof PROVIDERS)[number]["key"];

const providerFor = (key: ProviderKey) => PROVIDERS.find((p) => p.key === key)!;

/** Compare two base URLs as endpoints, not as strings. Mirrors the server. */
function sameEndpoint(a: string, b: string): boolean {
  const norm = (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/** Which provider a saved base URL belongs to, so editing opens on it. */
function providerKindFor(baseUrl: string): ProviderKey {
  const named = PROVIDERS.find((p) => p.baseUrl && sameEndpoint(p.baseUrl, baseUrl));
  return named?.key ?? "custom";
}

/**
 * What the model picker offers, given what the endpoint listed and what is
 * currently configured.
 *
 * The rule worth naming: a configured model that the endpoint does not
 * enumerate stays in the list. Gateways alias, hosted providers retire names,
 * and a picker that quietly dropped the configured value would switch the
 * workspace's model to whatever happened to sort first the next time an admin
 * opened the form to change something else.
 */
export function modelPickerOptions(
  models: string[] | null,
  configured: string,
): string[] {
  if (!models || models.length === 0) return [];
  return configured && !models.includes(configured) ? [configured, ...models] : models;
}

/**
 * Model families that cannot answer a chat completion.
 *
 * A hosted provider lists everything it serves, which is speech, images,
 * embeddings, moderation and video alongside the models this product can
 * actually use: OpenAI returned 130 entries, roughly a quarter of them
 * unusable here. Offering `whisper-1` as the workspace's assistant model is
 * not a neutral act, because the failure it produces arrives much later and
 * reads as the assistant being broken.
 *
 * Matching by name is a heuristic and heuristics are wrong eventually, so this
 * is a filter over the *display* only. The endpoint's full answer is always
 * one click away, nothing is dropped from the request, and a name we have
 * never seen is kept rather than hidden: the cost of wrongly hiding a usable
 * model is much higher than of showing a few extra.
 */
const NOT_CHAT =
  /(^|[-_])(embedding|embeddings|tts|whisper|transcribe|transcription|moderation|image|dall-e|sora|realtime|audio|rerank|video|speech)([-_]|$)/i;

/**
 * The subset worth showing first. Falls back to the whole list rather than to
 * nothing, because an endpoint whose every model looks unusual to this filter
 * is far likelier to be an unfamiliar gateway than a genuinely empty one.
 */
export function commonModels(models: string[]): string[] {
  const chat = models.filter((id) => !NOT_CHAT.test(id));
  return chat.length > 0 ? chat : models;
}

/** A message that reads as what it is, rather than as more helper text. */
function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  if (notice.kind === "ok") {
    return <p className="text-sm text-muted-foreground">{notice.message}</p>;
  }
  return (
    <p
      role="alert"
      className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {notice.message}
    </p>
  );
}

/**
 * The workspace's model connection, under Integrations beside repositories and
 * webhooks, which is where the product's other outbound connections live.
 *
 * Follows the project convention that adding starts as an affordance: with
 * nothing connected this is a single "Connect a model" button, and the form
 * expands in place only once someone asks for it.
 *
 * ── Why the form is ordered the way it is ───────────────────────────────────
 * Provider, then key, then model. Each step is what makes the next one
 * answerable: the provider fixes the base URL, the key is what lets us ask the
 * endpoint what it serves, and only then is there a list to choose a model
 * from. Offering the model field first invited people to press "list models"
 * with no key and read a 401 as their configuration being broken, when they
 * had simply been asked the questions in an order that could not work.
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
  const [kind, setKind] = useState<ProviderKey>(
    providerKindFor(initialProvider?.baseUrl ?? ""),
  );
  const [baseUrl, setBaseUrl] = useState(initialProvider?.baseUrl ?? "");
  const [model, setModel] = useState(initialProvider?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<Notice>(null);
  const [testResult, setTestResult] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();
  const [testing, setTesting] = useState(false);
  // null means "not asked yet", which is a different thing from an endpoint
  // that answered with nothing. Both end at a typed model name.
  const [models, setModels] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listNote, setListNote] = useState<Notice>(null);
  // Set once the endpoint has told us it cannot enumerate, or once someone
  // asks to type a name. Until then a new connection has no model field at
  // all, which is the point of the ordering.
  const [freeText, setFreeText] = useState(false);
  // Show the chat-capable subset first. Everything the endpoint listed stays
  // one click away, because the filter is a name heuristic and the user knows
  // their own endpoint better than the heuristic does.
  const [showAll, setShowAll] = useState(false);

  const selected = providerFor(kind);
  const shortlist = models ? commonModels(models) : null;
  const modelOptions = modelPickerOptions(showAll ? models : shortlist, model);
  /** Only worth offering the toggle when the filter actually hid something. */
  const hiddenCount = models && shortlist ? models.length - shortlist.length : 0;
  /** A stored key can only be reused against the endpoint it was stored for. */
  const hasUsableStoredKey = Boolean(
    provider?.credentialHint && provider && sameEndpoint(provider.baseUrl, baseUrl),
  );
  const canProbe =
    baseUrl.trim().length > 0 &&
    (apiKey.trim().length > 0 || hasUsableStoredKey || selected.keyless);

  function openForm() {
    const startingUrl = provider?.baseUrl ?? "";
    setKind(providerKindFor(startingUrl));
    setBaseUrl(startingUrl);
    setModel(provider?.model ?? "");
    setApiKey("");
    setStatus(null);
    setModels(null);
    setListNote(null);
    // An already-saved model was chosen against a key that worked, so editing
    // one does not have to re-earn the right to see the field.
    setFreeText(Boolean(provider?.model));
    setOpen(true);
  }

  function cancel() {
    setOpen(false);
    setStatus(null);
  }

  /** A model list belongs to one endpoint and one key. */
  function forgetModels() {
    setModels(null);
    setListNote(null);
    setShowAll(false);
  }

  function chooseProvider(next: ProviderKey) {
    setKind(next);
    const preset = providerFor(next).baseUrl;
    setBaseUrl(preset);
    setModel("");
    setApiKey("");
    setFreeText(false);
    forgetModels();
  }

  /**
   * Check the key by asking the endpoint what it serves.
   *
   * Listing doubles as the credential check, which is why it is under the key
   * field rather than the model one: a 401 here says the key is wrong, a list
   * says it is right, and either answer arrives before anyone has been asked
   * to choose a model.
   */
  async function loadModels() {
    setListing(true);
    setListNote(null);
    try {
      const res = await fetch("/api/v1/model-provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        models?: string[];
        error?: string;
      };

      if (data.ok && data.models && data.models.length > 0) {
        setModels(data.models);
        setFreeText(false);
        setShowAll(false);
        // Counts what the picker is about to show, not what the endpoint said,
        // because "130 models available" beside a list of 96 is its own small
        // puzzle for the reader to solve.
        const shown = commonModels(data.models).length;
        setListNote({
          kind: "ok",
          message: `Key accepted. ${shown} model${shown === 1 ? "" : "s"} available below.`,
        });
        return;
      }

      // Everything else ends at a typed model name, including the ordinary
      // case of an endpoint with no listing route: most self-hosted runtimes
      // serve one set of weights and have nothing to enumerate.
      setModels(null);
      setFreeText(true);
      setListNote(
        data.ok
          ? {
              kind: "ok",
              message:
                "Key accepted, but this endpoint does not list its models. " +
                "Type the name it serves.",
            }
          : {
              kind: "error",
              message: data.error ?? "Could not reach the endpoint.",
            },
      );
    } catch {
      setModels(null);
      setFreeText(true);
      setListNote({ kind: "error", message: "Could not reach the endpoint." });
    } finally {
      setListing(false);
    }
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
        // The server recorded this call against the connection. Reflect it,
        // or "Last used: Never" sits directly beneath a successful test until
        // someone reloads, which reads as the test not having counted.
        setProvider((p) => (p ? { ...p, lastUsedAt: new Date().toISOString() } : p));
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
        <NoticeLine notice={status} />

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
                  {provider.lastUsedAt ? (
                    <LocalTime iso={provider.lastUsedAt} />
                  ) : (
                    "Never"
                  )}
                </span>
              </div>
            </div>

            <NoticeLine notice={testResult} />

            {canManage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={test}
                  disabled={testing}
                >
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
          <div className="space-y-5 rounded border p-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-provider-kind">
                1. Provider
              </label>
              <Select
                id="model-provider-kind"
                value={kind}
                onChange={(e) => chooseProvider(e.target.value as ProviderKey)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{selected.hint}</p>
            </div>

            {kind === "custom" && (
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="model-base-url">
                  Base URL
                </label>
                <Input
                  id="model-base-url"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    forgetModels();
                  }}
                  placeholder="http://localhost:11434/v1"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  The API root, ending at the version segment.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-api-key">
                2. API key
              </label>
              <Input
                id="model-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  forgetModels();
                }}
                placeholder={
                  provider?.credentialHint && hasUsableStoredKey
                    ? `Leave blank to keep ••••${provider.credentialHint}`
                    : selected.keyless
                      ? "Leave blank if the endpoint needs no key"
                      : "Paste your key"
                }
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Encrypted at rest and never sent back to the browser.
              </p>

              <div className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadModels}
                  disabled={listing || !canProbe}
                >
                  {listing
                    ? "Checking…"
                    : models
                      ? "Check again"
                      : "Check the key and load models"}
                </Button>
              </div>

              <div className="pt-1">
                <NoticeLine notice={listNote} />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="model-name">
                3. Model
              </label>
              {modelOptions.length > 0 ? (
                <>
                  <Select
                    id="model-name"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {!model && <option value="">Choose a model</option>}
                    {modelOptions.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </Select>
                  <div className="flex flex-wrap items-center gap-3">
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                        onClick={() => setShowAll((v) => !v)}
                      >
                        {showAll
                          ? `Show only the ${(models?.length ?? 0) - hiddenCount} models that can hold a conversation`
                          : `Show all ${models?.length ?? 0}, including ${hiddenCount} for speech, images and embeddings`}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      onClick={() => {
                        setModels(null);
                        setFreeText(true);
                      }}
                    >
                      Type a name instead
                    </button>
                  </div>
                </>
              ) : freeText ? (
                <>
                  <Input
                    id="model-name"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="gpt-4o-mini"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Passed to the endpoint exactly as written.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Check the key above and the models this endpoint serves will
                  appear here.
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={save}
                disabled={pending || !baseUrl.trim() || !model.trim()}
              >
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
