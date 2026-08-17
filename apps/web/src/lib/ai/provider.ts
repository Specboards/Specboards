/**
 * The one interface the rest of the product calls to reach a model.
 *
 * Its real job is to make swapping inference a configuration change rather than
 * a rewrite: today every workspace brings its own endpoint, and if we ever ship
 * first-party inference it should arrive as another implementation of this and
 * nothing else. A wide interface that leaks provider specifics into callers
 * would not survive that, so this is deliberately the smallest surface the
 * assistant epic actually needs.
 *
 * Streaming is NOT here yet. It is the obvious next method and the shape is
 * known, but nothing calls it, and an unused method with no caller to constrain
 * it tends to be the wrong shape by the time one arrives.
 */

/** A single turn. `system` is separated by the adapter, not by callers. */
export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ModelMessage[];
  /** Upper bound on generated tokens. Adapters pass this through. */
  maxTokens?: number;
  /** 0-2 in the OpenAI vocabulary; omitted means the endpoint's own default. */
  temperature?: number;
  /** Wall-clock budget for the whole call. */
  timeoutMs?: number;
}

/** What a call actually cost, as reported by the endpoint. */
export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  /** The model the endpoint says answered, which is not always the one asked
   * for: gateways and hosted providers both alias and substitute. Surfacing it
   * is how a connection test can report what really served the request. */
  model: string | null;
}

/**
 * Why failures are a return value rather than a thrown error: every caller of
 * this is user-facing configuration or an assistant turn, and both need to tell
 * someone *which* thing went wrong. A thrown `Error` collapses "your key is
 * wrong", "your endpoint is unreachable" and "you asked for a model this server
 * does not have" into one string that the UI then has to pattern-match.
 *
 * `kind` is the part the UI branches on; `message` is safe to show. Neither
 * ever contains the credential.
 */
export type ModelErrorKind =
  /** Endpoint rejected the credential (401/403). */
  | "auth"
  /** Endpoint refused the model id (404, or a 400 naming the model). */
  | "model"
  /** Provider rate limit or overload (429/503). */
  | "rate_limit"
  /** Could not connect, DNS failure, TLS failure, or the timeout fired. */
  | "unreachable"
  /** Egress policy refused the address before any request was made. */
  | "blocked"
  /** Reached it, got something we could not parse as a completion. */
  | "protocol"
  /** Anything else, including unexpected 5xx. */
  | "unknown";

export interface ModelError {
  kind: ModelErrorKind;
  message: string;
  /** HTTP status when there was one; null for transport and policy failures. */
  status: number | null;
}

export type CompletionOutcome =
  | ({ ok: true } & CompletionResult)
  | { ok: false; error: ModelError };

/** Everything an adapter needs to make a call. Never leaves the server. */
export interface ProviderConfig {
  baseUrl: string;
  model: string;
  /** Plaintext; callers decrypt. Null for an endpoint that wants no auth. */
  apiKey: string | null;
}

export interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionOutcome>;
}
