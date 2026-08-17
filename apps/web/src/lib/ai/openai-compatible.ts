import { fetch as undiciFetch } from "undici";

import { pinnedAgent } from "@/lib/egress";
import { resolveModelTarget } from "@/lib/ai/egress";
import type {
  CompletionOutcome,
  CompletionRequest,
  ModelClient,
  ModelError,
  ModelErrorKind,
  ModelListOutcome,
  ProviderConfig,
  TokenUsage,
} from "@/lib/ai/provider";

/**
 * The only adapter, and for now the only one worth having: `POST /chat/completions`
 * in the OpenAI request shape.
 *
 * That shape is the lingua franca rather than one vendor's API. OpenAI, Groq,
 * Together, OpenRouter, Fireworks and Anthropic's compatibility endpoint all
 * accept it, and so do vLLM, llama.cpp, LM Studio, Ollama and the gateways
 * on-prem customers put in front of their own weights. One adapter therefore
 * covers both halves of "bring your own model" without a per-vendor
 * implementation, and a native adapter becomes something we add when a feature
 * needs a capability this shape cannot express, rather than up front on the
 * assumption that it will.
 *
 * Every call re-validates the endpoint against the egress policy and pins the
 * connection to the address that passed. See `@/lib/ai/egress` for why the
 * policy differs from the webhook one.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Listing is a small response and someone is watching it happen. */
const DEFAULT_LIST_TIMEOUT_MS = 10_000;

/** Map an HTTP status onto the error vocabulary callers branch on. */
function kindForStatus(status: number, body: string): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 429) return "rate_limit";
  if (status === 503) return "rate_limit";
  // A 400 is usually a bad model id, but not always, so only claim "model"
  // when the endpoint said so. Everything else stays "unknown" rather than
  // being confidently mislabelled.
  if (status === 400 && /model/i.test(body)) return "model";
  return "unknown";
}

/**
 * The same statuses mean different things when listing.
 *
 * A 404 or 405 on `/models` is the common, blameless case: the endpoint serves
 * completions and has no listing route at all, which is most self-hosted
 * runtimes. Reporting that as a failure would push people to fix a
 * configuration that is already correct, so it maps to `unsupported` and the
 * caller falls back to a typed model name.
 */
function kindForListStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 405 || status === 501) return "unsupported";
  if (status === 429 || status === 503) return "rate_limit";
  return "unknown";
}

/**
 * Endpoints disagree about where the human-readable reason lives: OpenAI uses
 * `{error: {message}}`, some gateways use `{message}`, vLLM sometimes returns
 * bare text. Try the shapes, fall back to a truncated body, and never return
 * the whole thing since it can be long and can echo the request.
 */
function reasonFromBody(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const err = o.error;
      if (err && typeof err === "object") {
        const m = (err as Record<string, unknown>).message;
        if (typeof m === "string" && m.trim()) return m.trim();
      }
      if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
      if (typeof err === "string" && err.trim()) return err.trim();
    }
  } catch {
    // Not JSON; fall through to the raw-text path.
  }
  const trimmed = body.trim();
  if (!trimmed) return null;
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function usageFrom(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

/**
 * Join the configured base URL to a path without producing a double slash or,
 * worse, dropping a path prefix. `new URL("chat/completions", base)` would
 * discard the `/v1` on `https://host/v1` unless the base has a trailing slash,
 * which is a misconfiguration users hit constantly and one this should absorb
 * rather than report.
 */
export function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A reply that arrived, or the reason none did. */
type Transport =
  | { ok: true; status: number; text: string }
  | { ok: false; error: ModelError };

/**
 * One request to the endpoint, with the parts every call shares: the egress
 * check, the pinned connection, the headers, and the transport failures that
 * are not the endpoint's answer but the absence of one.
 *
 * Status interpretation is deliberately left to callers, because the same
 * status does not mean the same thing on every route.
 */
async function send(
  config: ProviderConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string },
  timeoutMs: number,
): Promise<Transport> {
  // Re-checked per call, not just on save: tightening the deployment policy
  // has to take effect on rows written while it was looser, and DNS can
  // move under a hostname that was public when it was configured.
  const target = await resolveModelTarget(config.baseUrl);
  if (!target.ok) {
    return { ok: false, error: { kind: "blocked", message: target.reason, status: null } };
  }

  const agent =
    target.addresses.length > 0 ? pinnedAgent(target.addresses, timeoutMs) : undefined;

  try {
    const res = await undiciFetch(endpointUrl(config.baseUrl, path), {
      method: init.method,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        "User-Agent": "Specboards/1.0",
        // Bearer is what every OpenAI-compatible server accepts. An
        // endpoint with no auth gets no header at all rather than an empty
        // one, which some servers reject outright.
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      // Never follow a redirect: the destination has not been through the
      // egress check, so a 30x is a way around it.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(agent ? { dispatcher: agent } : {}),
    });

    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    // undici throws for DNS, TLS, connection refused and the abort signal.
    // All of them are "we could not reach it", which is the one the user can
    // act on, so they are not split further here.
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `The model endpoint did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the model endpoint: ${
            err instanceof Error ? err.message : "request failed"
          }`;
    return { ok: false, error: { kind: "unreachable", message, status: null } };
  } finally {
    await agent?.close().catch(() => {});
  }
}

/**
 * Pull model ids out of whatever came back.
 *
 * `{data: [{id}]}` is the OpenAI shape and what most servers return; a bare
 * array is what a few gateways return. Anything else is treated as "this route
 * is not a model list" rather than parsed speculatively. Entries without a
 * string id are dropped rather than rendered as blanks in a picker.
 */
function modelIdsFrom(parsed: unknown): string[] | null {
  const root = parsed as Record<string, unknown> | unknown[] | null;
  const rows = Array.isArray(root)
    ? root
    : root && typeof root === "object" && Array.isArray((root as Record<string, unknown>).data)
      ? ((root as Record<string, unknown>).data as unknown[])
      : null;
  if (!rows) return null;

  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row === "string" && row.trim()) {
      ids.add(row.trim());
      continue;
    }
    const id = (row as Record<string, unknown> | null)?.id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  // Alphabetical rather than as-served: a hosted provider returns dozens in no
  // useful order, and a stable order is what makes a long picker scannable.
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function createOpenAiCompatibleClient(config: ProviderConfig): ModelClient {
  return {
    async complete(req: CompletionRequest): Promise<CompletionOutcome> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const body = JSON.stringify({
        model: config.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: false,
      });

      const res = await send(config, "chat/completions", { method: "POST", body }, timeoutMs);
      if (!res.ok) return res;

      if (res.status < 200 || res.status >= 300) {
        const reason = reasonFromBody(res.text);
        return {
          ok: false,
          error: {
            kind: kindForStatus(res.status, res.text),
            message: reason
              ? `The model endpoint returned HTTP ${res.status}: ${reason}`
              : `The model endpoint returned HTTP ${res.status}.`,
            status: res.status,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        return {
          ok: false,
          error: {
            kind: "protocol",
            message:
              "The endpoint replied with something that is not JSON. Check that " +
              "the base URL points at an OpenAI-compatible API root.",
            status: res.status,
          },
        };
      }

      const root = (parsed ?? {}) as Record<string, unknown>;
      const choices = Array.isArray(root.choices) ? root.choices : [];
      const first = (choices[0] ?? {}) as Record<string, unknown>;
      const message = (first.message ?? {}) as Record<string, unknown>;
      const content = message.content;

      if (typeof content !== "string") {
        return {
          ok: false,
          error: {
            kind: "protocol",
            message:
              "The endpoint replied without a message. It answered, but not in " +
              "the OpenAI chat-completions shape.",
            status: res.status,
          },
        };
      }

      return {
        ok: true,
        text: content,
        usage: usageFrom(root.usage),
        model: typeof root.model === "string" ? root.model : null,
      };
    },

    async listModels(opts): Promise<ModelListOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;

      const res = await send(config, "models", { method: "GET" }, timeoutMs);
      if (!res.ok) return res;

      if (res.status < 200 || res.status >= 300) {
        const kind = kindForListStatus(res.status);
        const reason = reasonFromBody(res.text);
        return {
          ok: false,
          error: {
            kind,
            message:
              kind === "unsupported"
                ? "This endpoint does not list the models it serves."
                : reason
                  ? `The model endpoint returned HTTP ${res.status}: ${reason}`
                  : `The model endpoint returned HTTP ${res.status}.`,
            status: res.status,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        // A 200 that is not JSON is the wrong-base-URL symptom (pointed at a
        // web page), which is worth reporting rather than absorbing as "cannot
        // enumerate": the completion call is about to fail the same way.
        return {
          ok: false,
          error: {
            kind: "protocol",
            message:
              "The endpoint replied with something that is not JSON. Check that " +
              "the base URL points at an OpenAI-compatible API root.",
            status: res.status,
          },
        };
      }

      const models = modelIdsFrom(parsed);
      if (!models) {
        return {
          ok: false,
          error: {
            kind: "unsupported",
            message: "This endpoint answered, but not with a list of models.",
            status: res.status,
          },
        };
      }

      return { ok: true, models };
    },
  };
}
