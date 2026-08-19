/**
 * Ceilings on what a model endpoint is allowed to send back.
 *
 * Inbound request bodies have been capped since `lib/api/body.ts`: a
 * byte-counting reader that cancels the stream on the chunk that crosses the
 * limit. Responses got none of that treatment, and they are the side we control
 * less. The base URL is chosen by an org owner, passes the egress guard by
 * being a genuinely public address, and is then a server we make requests to
 * and read whatever comes back.
 *
 * Four bounds, because the ways a response can be unbounded are different
 * shapes and one number cannot cover them:
 *
 * - a whole body read at once, which was `await res.text()` with no cap;
 * - a single SSE `data:` line, which the stream parser buffers until it sees a
 *   newline, so a body that never sends one grows forever;
 * - the total a stream may send, which nothing bounded at all: an endpoint
 *   emitting valid small chunks forever is caught by neither of the above, and
 *   the caller accumulates the answer to persist it;
 * - how long a stream may run, since the existing timer is an idle timer that
 *   resets on every chunk, so a slow endless trickle resets it forever.
 *
 * The numbers are chosen to sit far above any legitimate answer and far below
 * anything that threatens a 512 MB machine shared with other tenants. They are
 * deliberately not configurable: an operator who needs a 3 MB completion has a
 * different problem, and a per-deployment knob here would be one more thing a
 * hostile endpoint's owner could argue should be raised.
 */

/**
 * A whole response read in one go: error bodies, the model list, and the
 * non-streaming completion path.
 *
 * A model list from a large gateway is tens of kilobytes. A non-streamed
 * completion is bounded by the output ceiling we ask for, which is a few
 * hundred kilobytes of text at the very top end. 2 MB is roughly an order of
 * magnitude above the largest thing we have any business receiving.
 */
export const MAX_RESPONSE_BYTES = 1_000_000 * 2;

/**
 * One SSE `data:` line, held in the parser's buffer until its newline arrives.
 *
 * A chunk carries a token or two, so a legitimate line is a few hundred bytes.
 * 1 MB is the same ceiling the inbound bodies use and about a thousand times
 * more than any real chunk needs.
 */
export const MAX_SSE_LINE_BYTES = 1_000_000;

/**
 * Everything one stream may send, added up.
 *
 * The per-line cap does not catch an endpoint that emits valid small chunks
 * forever, and the deltas do not simply pass through: the assistant accumulates
 * the answer so it can persist it. 8 MB is far more text than any assistant
 * turn should produce (roughly two million tokens) and still small enough that
 * a handful of concurrent runaway streams cannot exhaust the machine.
 */
export const MAX_STREAM_BYTES = 1_000_000 * 8;

/**
 * How long one stream may run in total, alongside the idle timer rather than
 * instead of it.
 *
 * The idle timer is the right tool for a stalled stream and no use against a
 * slow endless one, because every chunk resets it. Ten minutes is well past any
 * honest completion (a long answer from a slow self-hosted model is minutes,
 * not tens of minutes) and bounds the case where an endpoint trickles a byte
 * every few seconds forever.
 */
export const MAX_STREAM_MS = 10 * 60_000;

/** Which ceiling a stream hit, or null while it is behaving. */
export type StreamLimit = "line" | "total" | "time";

/**
 * The stream ceilings as one decision, separate from the reading loop.
 *
 * Pure and exported so all three can be tested exactly, including the
 * wall-clock one, which is otherwise a ten-minute test. The loop calls this
 * once per chunk; everything it needs is a count it already has.
 */
export function streamLimitExceeded(state: {
  /** Length of the unparsed tail, which is one `data:` line still arriving. */
  bufferedChars: number;
  /** Every byte this stream has delivered so far. */
  streamedBytes: number;
  /** How long the stream has been running. */
  elapsedMs: number;
}): StreamLimit | null {
  if (state.bufferedChars > MAX_SSE_LINE_BYTES) return "line";
  if (state.streamedBytes > MAX_STREAM_BYTES) return "total";
  if (state.elapsedMs > MAX_STREAM_MS) return "time";
  return null;
}

/** What to tell the caller when a stream is cut off. */
export function describeStreamLimit(limit: StreamLimit): string {
  switch (limit) {
    case "line":
      return (
        "The model endpoint sent a single stream line larger than " +
        `${MAX_SSE_LINE_BYTES / 1_000_000} MB. A chunk carries a token or two, ` +
        "so this endpoint is not speaking the protocol it claimed."
      );
    case "total":
      return (
        `The model endpoint streamed more than ${MAX_STREAM_BYTES / 1_000_000} MB ` +
        "in one answer, which is far more than any reply should be."
      );
    case "time":
      return (
        `The model endpoint was still streaming after ${MAX_STREAM_MS / 60_000} ` +
        "minutes. A slow endless stream never trips the idle timer, so this is " +
        "the ceiling that stops it."
      );
  }
}

/**
 * Just enough of a response to meter it.
 *
 * Structural rather than `Response`, because undici's `Response.body` is typed
 * as `ReadableStream<any>` and the DOM's as `ReadableStream<Uint8Array>`. Both
 * satisfy this, and so does a hand-rolled stub in a test, which is the point:
 * the limits are worth exercising without a live endpoint.
 */
export interface BoundedResponse {
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<unknown>;
      releaseLock(): void;
    };
  } | null;
  text: () => Promise<string>;
}

/**
 * Read a response body as text, refusing once it exceeds `limit` bytes.
 *
 * Returns `null` when the limit is crossed, having cancelled the body so the
 * connection is not left draining. The same two properties as
 * `readTextBodyWithin` on the request side, for the same reasons: it stops
 * reading rather than checking a string it has already buffered, and it counts
 * bytes rather than UTF-16 code units, which a multi-byte body would otherwise
 * exceed by up to four times while passing a byte-named check.
 */
export async function readResponseTextWithin(
  res: BoundedResponse,
  limit: number = MAX_RESPONSE_BYTES,
): Promise<string | null> {
  // No stream to meter (a mocked response, or one with no body at all): fall
  // back to reading it whole and checking, which is the weaker guarantee but
  // the only one available.
  if (!res.body) {
    const text = await res.text();
    return new TextEncoder().encode(text).length > limit ? null : text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return out + decoder.decode();
}
