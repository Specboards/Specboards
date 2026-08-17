import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpenAiCompatibleClient, endpointUrl } from "./openai-compatible";

/**
 * The adapter, driven against a real HTTP server rather than a mocked `fetch`.
 *
 * Worth the extra machinery: the things most likely to be wrong here are the
 * URL join, the headers actually put on the wire, and the mapping from a real
 * response to the error vocabulary the UI branches on. A mocked fetch would
 * assert what the test author believed those were.
 *
 * The server is on 127.0.0.1, which the egress policy blocks by default, so
 * these run as a self-hosted deployment that has opted in. That is the same
 * configuration an on-prem customer uses to reach their own vLLM box, so the
 * suite exercises the self-hosted path as a side effect.
 */

let server: Server | undefined;
let baseUrl = "";
let lastRequest: { url: string; headers: Record<string, string>; body: string } | null =
  null;

/** Reply with a fixed status/body and record what arrived. */
function serve(status: number, body: string, contentType = "application/json") {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastRequest = {
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    });
  });
  return new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

const OK_BODY = JSON.stringify({
  model: "test-model-actual",
  choices: [{ message: { role: "assistant", content: "ready" } }],
  usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 },
});

beforeEach(() => {
  process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
  delete process.env.SPECBOARDS_MULTI_TENANT;
  lastRequest = null;
});

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
});

const call = (apiKey: string | null = "sk-test-key-a91c", model = "test-model") =>
  createOpenAiCompatibleClient({ baseUrl, model, apiKey }).complete({
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 16,
    timeoutMs: 5_000,
  });

describe("endpointUrl", () => {
  it("keeps a path prefix that a naive URL join would discard", () => {
    // `new URL("chat/completions", "https://h/v1")` yields https://h/chat/... ,
    // silently dropping /v1. That misconfiguration is one users hit constantly.
    expect(endpointUrl("https://h/v1", "chat/completions")).toBe(
      "https://h/v1/chat/completions",
    );
  });

  it("tolerates a trailing slash without doubling it", () => {
    expect(endpointUrl("https://h/v1/", "chat/completions")).toBe(
      "https://h/v1/chat/completions",
    );
  });
});

describe("a successful completion", () => {
  it("returns the text, usage and the model that actually served it", async () => {
    await serve(200, OK_BODY);
    const out = await call();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.text).toBe("ready");
    expect(out.usage).toEqual({
      promptTokens: 7,
      completionTokens: 1,
      totalTokens: 8,
    });
    // Not the model we asked for: gateways alias and substitute, and a
    // connection test should report what really answered.
    expect(out.model).toBe("test-model-actual");
  });

  it("posts to <base>/chat/completions with the bearer token", async () => {
    await serve(200, OK_BODY);
    await call();
    expect(lastRequest?.url).toBe("/v1/chat/completions");
    expect(lastRequest?.headers.authorization).toBe("Bearer sk-test-key-a91c");
    const sent = JSON.parse(lastRequest!.body) as Record<string, unknown>;
    expect(sent.model).toBe("test-model");
    expect(sent.stream).toBe(false);
    expect(sent.max_tokens).toBe(16);
  });

  it("sends no Authorization header at all when there is no key", async () => {
    await serve(200, OK_BODY);
    await call(null);
    // Not an empty one: some servers reject `Authorization: Bearer ` outright,
    // and a keyless local endpoint is a first-class case.
    expect(lastRequest?.headers.authorization).toBeUndefined();
  });
});

describe("error mapping", () => {
  it("maps 401 to auth", async () => {
    await serve(401, JSON.stringify({ error: { message: "Invalid API key" } }));
    const out = await call();
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe("auth");
    expect(out.error.status).toBe(401);
    expect(out.error.message).toContain("Invalid API key");
  });

  it("maps 404 to model", async () => {
    await serve(404, JSON.stringify({ error: { message: "no such model" } }));
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("model");
  });

  it("maps 429 to rate_limit", async () => {
    await serve(429, JSON.stringify({ error: { message: "slow down" } }));
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("rate_limit");
  });

  it("calls a 400 a model error only when the body says so", async () => {
    await serve(400, JSON.stringify({ error: { message: "unknown model foo" } }));
    expect((await call()).ok === false).toBe(true);
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("model");

    server?.close();
    await serve(400, JSON.stringify({ error: { message: "bad temperature" } }));
    const other = await call();
    // Not confidently mislabelled as a model problem.
    expect(other.ok === false && other.error.kind).toBe("unknown");
  });

  it("reads a bare {message} body, which some gateways return", async () => {
    await serve(403, JSON.stringify({ message: "forbidden by policy" }));
    const out = await call();
    expect(out.ok === false && out.error.message).toContain("forbidden by policy");
  });

  it("falls back to raw text when the body is not JSON", async () => {
    await serve(500, "upstream exploded", "text/plain");
    const out = await call();
    expect(out.ok === false && out.error.message).toContain("upstream exploded");
  });

  it("reports non-JSON success as a protocol error, not a crash", async () => {
    // The classic wrong-base-URL symptom: pointed at a web page, got HTML 200.
    await serve(200, "<html>hello</html>", "text/html");
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("protocol");
    expect(out.ok === false && out.error.message).toMatch(/OpenAI-compatible API root/);
  });

  it("reports a JSON reply with no message as a protocol error", async () => {
    await serve(200, JSON.stringify({ choices: [] }));
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("protocol");
  });

  it("reports an unreachable endpoint rather than throwing", async () => {
    // Nothing is listening on this port; no server started for this case.
    baseUrl = "http://127.0.0.1:1/v1";
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("unreachable");
    expect(out.ok === false && out.error.status).toBeNull();
  });

  it("refuses a blocked address before making any request", async () => {
    await serve(200, OK_BODY);
    // Same endpoint, but now as a hosted deployment: the policy applies even
    // though the row was written when it did not.
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("blocked");
    expect(lastRequest).toBeNull();
    delete process.env.SPECBOARDS_MULTI_TENANT;
  });
});
