import { describe, expect, it } from "vitest";

import { createOpenAiCompatibleClient } from "./openai-compatible";

/**
 * The adapter against a genuinely self-hosted inference runtime.
 *
 * Everything else in this directory drives a server written by the same person
 * as the assertions, which proves the adapter is self-consistent and nothing
 * more. "OpenAI-compatible" is a claim each runtime makes about itself, and the
 * places they differ are exactly the places a stub would agree: whether
 * `/models` exists at all, what `usage` is populated with, whether the served
 * model name comes back, what a wrong model id returns. Until this has run
 * against a real one, on-prem support is an assertion.
 *
 * Named `.int.test.ts` for the same reason as the database suites - it needs
 * infrastructure that `pnpm test` does not provide - though the infrastructure
 * here is an inference runtime rather than Postgres. It needs no database.
 *
 * Opt in by pointing it at a runtime, which keeps a GPU-less CI green:
 *
 *   docker run -d -v ollama:/root/.ollama -p 127.0.0.1:11434:11434 \
 *     --name specboards-ollama ollama/ollama
 *   docker exec specboards-ollama ollama pull qwen2.5:0.5b
 *   SPECBOARDS_TEST_MODEL_URL=http://127.0.0.1:11434/v1 \
 *   SPECBOARDS_TEST_MODEL=qwen2.5:0.5b \
 *   SPECBOARDS_MODEL_ALLOW_PRIVATE=1 \
 *     pnpm vitest run src/lib/ai/self-hosted.int.test.ts
 *
 * `SPECBOARDS_MODEL_ALLOW_PRIVATE` is required because the runtime is on
 * loopback, which the egress policy refuses by default. Needing it here is the
 * point rather than an inconvenience: it is the same opt-in an on-prem
 * deployment makes, so this exercises that path too.
 */

const BASE_URL = process.env.SPECBOARDS_TEST_MODEL_URL;
const MODEL = process.env.SPECBOARDS_TEST_MODEL ?? "qwen2.5:0.5b";

// A small model on CPU is not fast, and the first call also loads weights.
const TIMEOUT_MS = 120_000;

const client = () =>
  createOpenAiCompatibleClient({ baseUrl: BASE_URL!, model: MODEL, apiKey: null });

describe.skipIf(!BASE_URL)("against a self-hosted runtime", () => {
  it(
    "completes a call",
    async () => {
      const outcome = await client().complete({
        messages: [
          { role: "system", content: "Reply with one word." },
          { role: "user", content: "Say ready." },
        ],
        maxTokens: 16,
        temperature: 0,
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.text.length).toBeGreaterThan(0);
      // Not asserted: what it says. The runtime's job here is the protocol.
    },
    TIMEOUT_MS,
  );

  it(
    "reports which model served the reply",
    async () => {
      // A gateway can serve something other than what was asked for, and this
      // is what the settings screen shows after a test call, so it has to be
      // populated by a real runtime and not only by our own stub.
      const outcome = await client().complete({
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 8,
        timeoutMs: TIMEOUT_MS,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.model).toBe(MODEL);
    },
    TIMEOUT_MS,
  );

  it(
    "reports token usage",
    async () => {
      // Usage is optional in the protocol and absent from several runtimes.
      // Whether this one populates it decides whether spend accounting can be
      // built on the adapter's numbers or has to estimate.
      const outcome = await client().complete({
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 8,
        timeoutMs: TIMEOUT_MS,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.usage.totalTokens).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "lists the models it serves",
    async () => {
      const outcome = await client().listModels({ timeoutMs: TIMEOUT_MS });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.models).toContain(MODEL);
    },
    TIMEOUT_MS,
  );

  it(
    "says a model it does not serve is a model problem",
    async () => {
      // The error vocabulary is what the UI branches on, and a runtime is free
      // to answer this with any status it likes. Ollama returns 404; OpenAI
      // returns 404; vLLM returns 400 naming the model. All three have to land
      // on `model` rather than `unknown`, or the message tells the user
      // nothing.
      const outcome = await createOpenAiCompatibleClient({
        baseUrl: BASE_URL!,
        model: "definitely-not-a-real-model",
        apiKey: null,
      }).complete({
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: TIMEOUT_MS,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.kind).toBe("model");
    },
    TIMEOUT_MS,
  );
});
