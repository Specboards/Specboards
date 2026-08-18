/**
 * Roughly what a request will cost, before it is sent.
 *
 * ── Why an approximation is the right answer here ───────────────────────────
 * The exact number needs the endpoint's own tokenizer, and we do not have one:
 * this product's whole premise is that the endpoint is whatever the customer
 * connected, which may be a hosted vendor, vLLM in their datacentre, or a
 * quantized model on somebody's laptop. Shipping a tokenizer would mean
 * shipping the *wrong* tokenizer for most of them, at a few megabytes, to
 * produce a number that is still an estimate.
 *
 * What the estimate is for decides how accurate it has to be. It answers "is
 * this about to cost me a hundred tokens or a hundred thousand", before a
 * person presses a button that spends their money. A ratio that is 20% out
 * never changes that answer; a missing estimate always does.
 *
 * ── The ratio ──────────────────────────────────────────────────────────────
 * Four characters per token, which is the long-standing rule of thumb for
 * English prose in BPE vocabularies and is what the major vendors themselves
 * publish as the back-of-envelope figure. It under-counts for code, dense
 * punctuation and non-Latin scripts, so {@link estimateTokens} rounds up and
 * callers present the result as "about".
 *
 * Pure: no database, no network, no environment.
 */

/** Characters per token, for English-ish prose. See the note above. */
const CHARS_PER_TOKEN = 4;

/**
 * Per-message overhead the wire format adds: role, delimiters, and the framing
 * a chat template wraps each turn in. Small, and worth counting because a long
 * thread of short turns is otherwise under-estimated by more than the ratio
 * error it is hiding inside.
 */
const PER_MESSAGE_TOKENS = 4;

/** About how many tokens a string is. Rounds up; never negative. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * About how many prompt tokens a set of turns will cost.
 *
 * Prompt only. What the model writes back cannot be estimated from the input at
 * all (that is the model's decision, bounded only by `maxTokens`), and a number
 * that silently guessed at it would be presenting a fabrication as a forecast.
 * Callers that want a total add their own `maxTokens` ceiling, which is a fact
 * rather than a guess.
 */
export function estimatePromptTokens(
  messages: readonly { content: string }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + PER_MESSAGE_TOKENS;
  }
  return total;
}

/**
 * The estimate as a person should read it: "about 1,200" rather than "1,203".
 *
 * Rounded to two significant figures, deliberately. Precision here is a lie
 * that gets believed: a reader shown "1,203 tokens" will reasonably assume we
 * counted them, and then treat the gap against their invoice as our error
 * rather than as the approximation it always was.
 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens <= 0) return "0";
  const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(tokens)) - 1));
  return (Math.round(tokens / magnitude) * magnitude).toLocaleString();
}
