import { fetch as undiciFetch } from "undici";

import { modelDispatcher, resolveModelTarget } from "@/lib/ai/egress";
import {
  MAX_RESPONSE_BYTES,
  describeStreamLimit,
  readResponseTextWithin,
  streamLimitExceeded,
} from "@/lib/ai/response-limits";
import type {
  CompletionOutcome,
  CompletionRequest,
  ModelClient,
  ModelError,
  ModelErrorKind,
  ModelListOutcome,
  ProviderConfig,
  StreamEvent,
  StreamRequest,
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

/**
 * An empty account, which OpenAI reports as a 429 and therefore as something
 * that looks exactly like "you are going too fast". Observed live: a workspace
 * with no credits gets `429 You have no credits remaining`, and treating that
 * as a rate limit would have the assistant back off and retry a call that can
 * never succeed until somebody visits a billing page.
 */
function isQuotaFailure(body: string): boolean {
  return /insufficient_quota|no credits remaining|exceeded your current quota|billing/i.test(
    body,
  );
}

/** Map an HTTP status onto the error vocabulary callers branch on. */
function kindForStatus(status: number, body: string): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  // Payment Required, which some gateways use where OpenAI overloads 429.
  if (status === 402) return "quota";
  if (status === 429) return isQuotaFailure(body) ? "quota" : "rate_limit";
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
function kindForListStatus(status: number, body: string): ModelErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 405 || status === 501) return "unsupported";
  if (status === 402) return "quota";
  if (status === 429) return isQuotaFailure(body) ? "quota" : "rate_limit";
  if (status === 503) return "rate_limit";
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

/**
 * Whether a 400 is the endpoint telling us it wants `max_completion_tokens`.
 *
 * The one place the lingua franca actually forked. `max_tokens` is what vLLM,
 * Ollama, llama.cpp and every gateway in front of them accept, and what OpenAI
 * accepted for years; OpenAI's newer models reject it outright and name the
 * replacement in the error. Keyed on the endpoint naming the parameter rather
 * than on a model-name pattern, because guessing which models have moved is a
 * list we would be maintaining forever and getting wrong for gateways that
 * alias them.
 */
function wantsCompletionTokens(body: string): boolean {
  return /max_completion_tokens/i.test(body);
}

/**
 * Headers a specific vendor needs on top of the common ones.
 *
 * Anthropic is the one case so far. Its chat-completions route accepts a
 * bearer token, because that route exists to be OpenAI-compatible; `/v1/models`
 * is its own native API and authenticates with `x-api-key`, so listing models
 * against a perfectly good Anthropic key returns `401 Invalid bearer token`.
 * A user reads that as "my key is wrong" and starts rotating credentials that
 * were never the problem.
 *
 * Both headers are sent on every request to that host rather than only on the
 * listing one: it costs nothing where the bearer already works, and it means
 * the rule is "this is how we talk to Anthropic" rather than a per-route
 * exception someone has to remember. Nothing is disclosed by doing so, since
 * the key is already going to that host in the `Authorization` header.
 */
export function vendorHeaders(
  baseUrl: string,
  apiKey: string | null,
): Record<string, string> {
  if (!apiKey) return {};
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (host === "api.anthropic.com") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return {};
}

/**
 * Certificate failures, and what an operator is supposed to do about each.
 *
 * These are the errors an on-prem deployment hits first: inference behind an
 * internal CA or a self-signed certificate, which Node does not trust. Left
 * alone they surface as an unreachable endpoint, and the natural response is to
 * go and look at firewalls, which is the wrong place entirely. Naming the
 * variable that fixes it turns a day into a minute.
 */
const TLS_ADVICE: Record<string, string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT:
    "The endpoint presented a self-signed certificate. Point " +
    "SPECBOARDS_MODEL_CA_CERT at that certificate to trust it.",
  SELF_SIGNED_CERT_IN_CHAIN:
    "The endpoint's certificate chain is signed by a private authority. Point " +
    "SPECBOARDS_MODEL_CA_CERT at that authority's certificate.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "The endpoint's certificate could not be verified against a known " +
    "authority. Point SPECBOARDS_MODEL_CA_CERT at your internal CA certificate.",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "The endpoint's certificate was issued by an authority this deployment " +
    "does not know. Point SPECBOARDS_MODEL_CA_CERT at your internal CA " +
    "certificate.",
  CERT_HAS_EXPIRED:
    "The endpoint's certificate has expired. Renew it at the endpoint; this is " +
    "not something Specboards can be configured around.",
  ERR_TLS_CERT_ALTNAME_INVALID:
    "The endpoint's certificate does not name the host in the base URL. Use " +
    "the hostname the certificate was issued for.",
};

/**
 * The reason a request never got a reply.
 *
 * undici reports every connection failure as the bare string "fetch failed"
 * and hangs the real error off `cause`, so reporting `err.message` tells the
 * user precisely nothing. Unwrapping is what makes a refused connection, a DNS
 * miss and an untrusted certificate distinguishable at all.
 */
export function transportReason(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const code =
    typeof (cause as { code?: unknown })?.code === "string"
      ? ((cause as { code: string }).code)
      : typeof (err as { code?: unknown })?.code === "string"
        ? ((err as { code: string }).code)
        : null;

  if (code && TLS_ADVICE[code]) return TLS_ADVICE[code];

  const detail =
    cause instanceof Error && cause.message
      ? cause.message
      : err instanceof Error && err.message
        ? err.message
        : "request failed";
  return code ? `${detail} (${code})` : detail;
}

/**
 * Pull complete `data:` payloads out of an accumulating SSE buffer.
 *
 * Returns the payloads that are definitely complete plus the bytes that are
 * not, which the caller feeds back in with the next chunk. Splitting this out
 * as a pure function is what makes the awkward part testable: a chunk boundary
 * falls wherever TCP decides, routinely mid-line and mid-JSON, and a parser
 * that assumes one chunk is one event works perfectly against a fast local
 * runtime and corrupts answers from a slow remote one.
 *
 * Comment lines (`:` keepalives, which several gateways send to hold the
 * connection open) and non-`data` fields are dropped rather than parsed.
 */
export function sseDataLines(buffer: string): { data: string[]; rest: string } {
  const data: string[] = [];
  // A trailing fragment with no newline yet is incomplete by definition. Note
  // this also correctly holds back a complete-looking line that simply has not
  // had its terminator arrive.
  const lastBreak = buffer.lastIndexOf("\n");
  if (lastBreak === -1) return { data, rest: buffer };

  const complete = buffer.slice(0, lastBreak);
  const rest = buffer.slice(lastBreak + 1);

  for (const raw of complete.split("\n")) {
    // \r\n line endings: the spec allows them and some servers emit them.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload) data.push(payload);
  }
  return { data, rest };
}

/** What one streamed chunk contributes. Any field may be absent. */
interface StreamChunk {
  text: string | null;
  model: string | null;
  usage: TokenUsage | null;
}

/**
 * Read one `data:` payload.
 *
 * Returns null for anything that is not a usable chunk, including the
 * `[DONE]` sentinel and any JSON we cannot make sense of. A malformed chunk in
 * the middle of an otherwise good stream is not worth failing the whole answer
 * over: the endpoint has already sent real text, and dropping one frame
 * degrades the answer where throwing would lose it.
 */
export function streamChunkFrom(payload: string): StreamChunk | null {
  if (payload === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const delta = (first.delta ?? {}) as Record<string, unknown>;
  const content = delta.content;
  return {
    text: typeof content === "string" && content !== "" ? content : null,
    model: typeof root.model === "string" ? root.model : null,
    // Present only on the final chunk, and only when the endpoint bothers.
    usage: root.usage ? usageFrom(root.usage) : null,
  };
}

/** Whether a 400 is the endpoint rejecting `stream_options` specifically. */
function rejectsStreamOptions(body: string): boolean {
  return /stream_options/i.test(body);
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

  const agent = modelDispatcher(target.addresses, timeoutMs);

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
        ...vendorHeaders(config.baseUrl, config.apiKey),
      },
      ...(init.body ? { body: init.body } : {}),
      // Never follow a redirect: the destination has not been through the
      // egress check, so a 30x is a way around it.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(agent ? { dispatcher: agent } : {}),
    });

    const text = await readResponseTextWithin(res);
    if (text === null) {
      return {
        ok: false,
        error: {
          kind: "protocol",
          message:
            `The model endpoint sent more than ${MAX_RESPONSE_BYTES / 1_000_000} MB ` +
            "in one response, which no answer to this request should need. " +
            "Check that the base URL points at an OpenAI-compatible API root.",
          status: res.status,
        },
      };
    }
    return { ok: true, status: res.status, text };
  } catch (err) {
    // undici throws for DNS, TLS, connection refused and the abort signal.
    // All of them are "we could not reach it", but the reason underneath is
    // what tells someone whether to fix a firewall, a URL or a certificate.
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `The model endpoint did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the model endpoint: ${transportReason(err)}`;
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

/** A stream event for an endpoint that is not speaking the protocol it claimed. */
function protocolError(status: number | null, message: string): StreamEvent {
  return { kind: "error", error: { kind: "protocol", message, status } };
}

/**
 * The streamed form of a completion.
 *
 * Written as its own function rather than folded into {@link send}, which
 * reads the whole body before returning: the entire point here is not to.
 *
 * ── The timeout is an idle timeout ──────────────────────────────────────────
 * `complete` bounds the whole call, which is right when one reply either
 * arrives or does not. Applying that to a stream would kill a perfectly
 * healthy answer for the crime of being long, and long answers are exactly
 * what streaming exists for. So the clock measures the gap between chunks and
 * resets on each one: a stream that is producing tokens is never interrupted,
 * and one that has silently stalled still fails rather than hanging forever.
 */
async function* streamCompletion(
  config: ProviderConfig,
  req: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const idleMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const target = await resolveModelTarget(config.baseUrl);
  if (!target.ok) {
    yield {
      kind: "error",
      error: { kind: "blocked", message: target.reason, status: null },
    };
    return;
  }

  const agent = modelDispatcher(target.addresses, idleMs);

  // Reset on every chunk; see the note above.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };

  /** True when the caller asked us to stop, as opposed to anything going wrong. */
  const cancelled = () => req.signal?.aborted === true;

  /** For the wall-clock ceiling; see MAX_STREAM_MS. */
  const startedAt = Date.now();

  try {
    bump();
    const signal = req.signal
      ? AbortSignal.any([idle.signal, req.signal])
      : idle.signal;

    // Two things an endpoint may reject that we would rather ask for: usage
    // reporting on the final chunk, and `max_tokens` under its older name.
    // Both are negotiated from what the server actually says, the same way
    // `complete` does it, rather than from a list of which vendors want what.
    let wantUsage = true;
    let tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";

    let res: Awaited<ReturnType<typeof undiciFetch>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = JSON.stringify({
        model: config.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.maxTokens !== undefined ? { [tokenParam]: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
        ...(wantUsage ? { stream_options: { include_usage: true } } : {}),
      });

      res = await undiciFetch(endpointUrl(config.baseUrl, "chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": "Specboards/1.0",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...vendorHeaders(config.baseUrl, config.apiKey),
        },
        body,
        redirect: "manual",
        signal,
        ...(agent ? { dispatcher: agent } : {}),
      });

      if (res.status !== 400) break;
      // Bounded like every other read: an error body is still a body, and this
      // one arrives before anything has decided the endpoint is well behaved.
      const text = (await readResponseTextWithin(res)) ?? "";
      // Only retry when the endpoint named the thing it did not like. A blind
      // retry would turn one bad request into three.
      if (wantUsage && rejectsStreamOptions(text)) {
        wantUsage = false;
        continue;
      }
      if (
        req.maxTokens !== undefined &&
        tokenParam === "max_tokens" &&
        wantsCompletionTokens(text)
      ) {
        tokenParam = "max_completion_tokens";
        continue;
      }
      yield {
        kind: "error",
        error: {
          kind: kindForStatus(400, text),
          message: reasonFromBody(text)
            ? `The model endpoint returned HTTP 400: ${reasonFromBody(text)}`
            : "The model endpoint returned HTTP 400.",
          status: 400,
        },
      };
      return;
    }

    if (!res) return;

    if (res.status < 200 || res.status >= 300) {
      const text = (await readResponseTextWithin(res)) ?? "";
      const reason = reasonFromBody(text);
      yield {
        kind: "error",
        error: {
          kind: kindForStatus(res.status, text),
          message: reason
            ? `The model endpoint returned HTTP ${res.status}: ${reason}`
            : `The model endpoint returned HTTP ${res.status}.`,
          status: res.status,
        },
      };
      return;
    }

    if (!res.body) {
      yield {
        kind: "error",
        error: {
          kind: "protocol",
          message: "The endpoint accepted the request but sent no stream.",
          status: res.status,
        },
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let model: string | null = null;
    let usage: TokenUsage | null = null;
    let sawText = false;
    let streamedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      streamedBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      // None of these is caught by the idle timer, which resets on every chunk
      // by design. Checked after adding the chunk so the counts include it, and
      // before parsing so an oversized buffer is refused rather than split.
      // Reported as a protocol error rather than thrown, so a caller that has
      // already rendered part of an answer is told why it stopped.
      const limit = streamLimitExceeded({
        bufferedChars: buffer.length,
        streamedBytes,
        elapsedMs: Date.now() - startedAt,
      });
      if (limit) {
        await reader.cancel().catch(() => {});
        yield protocolError(res.status, describeStreamLimit(limit));
        return;
      }

      const { data, rest } = sseDataLines(buffer);
      buffer = rest;
      for (const payload of data) {
        const chunk = streamChunkFrom(payload);
        if (!chunk) continue;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        if (chunk.text) {
          sawText = true;
          yield { kind: "delta", text: chunk.text };
        }
      }
    }

    if (!sawText && !usage) {
      // A stream that closed having said nothing at all is not a valid empty
      // answer, it is an endpoint that is not doing what it claimed. Reporting
      // it as an error beats rendering a blank reply the user cannot explain.
      yield {
        kind: "error",
        error: {
          kind: "protocol",
          message:
            "The endpoint opened a stream and closed it without sending an " +
            "answer. Check that the base URL points at an OpenAI-compatible " +
            "API root.",
          status: res.status,
        },
      };
      return;
    }

    yield {
      kind: "done",
      usage: usage ?? { promptTokens: null, completionTokens: null, totalTokens: null },
      model,
    };
  } catch (err) {
    // A caller-initiated cancel lands here as an abort. It is not a failure and
    // gets no terminal event: the iteration simply ends, which is how a
    // consumer tells "stopped on request" from "stopped because it broke".
    if (cancelled()) return;
    const message = idle.signal.aborted
      ? `The model endpoint stopped sending for ${Math.round(idleMs / 1000)}s.`
      : `Could not reach the model endpoint: ${transportReason(err)}`;
    yield {
      kind: "error",
      error: { kind: "unreachable", message, status: null },
    };
  } finally {
    if (timer) clearTimeout(timer);
    await agent?.close().catch(() => {});
  }
}

export function createOpenAiCompatibleClient(config: ProviderConfig): ModelClient {
  return {
    async complete(req: CompletionRequest): Promise<CompletionOutcome> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const bodyWith = (tokenParam: "max_tokens" | "max_completion_tokens") =>
        JSON.stringify({
          model: config.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(req.maxTokens !== undefined ? { [tokenParam]: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: false,
        });

      let res = await send(
        config,
        "chat/completions",
        { method: "POST", body: bodyWith("max_tokens") },
        timeoutMs,
      );
      if (!res.ok) return res;

      // Ask the way the endpoint just said it wants to be asked. One retry, and
      // only when it named the parameter itself: an adapter that negotiates
      // from what the server actually said stays correct as vendors move,
      // where a hardcoded rule about which models want which parameter would
      // need editing every time one ships.
      if (res.status === 400 && req.maxTokens !== undefined && wantsCompletionTokens(res.text)) {
        res = await send(
          config,
          "chat/completions",
          { method: "POST", body: bodyWith("max_completion_tokens") },
          timeoutMs,
        );
        if (!res.ok) return res;
      }

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

    stream(req: StreamRequest) {
      return streamCompletion(config, req);
    },

    async listModels(opts): Promise<ModelListOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;

      const res = await send(config, "models", { method: "GET" }, timeoutMs);
      if (!res.ok) return res;

      if (res.status < 200 || res.status >= 300) {
        const kind = kindForListStatus(res.status, res.text);
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
