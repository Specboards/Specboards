import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOpenAiCompatibleClient,
  endpointUrl,
  sseDataLines,
  streamChunkFrom,
  transportReason,
  vendorHeaders,
} from "./openai-compatible";
import type { ModelError, TokenUsage } from "./provider";

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
/** How many requests reached the endpoint, so a retry is visible. */
let requestCount = 0;

/** Publish whatever server has been built and point `baseUrl` at it. */
function listen(): Promise<void> {
  return new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

/** Reply with a fixed status/body and record what arrived. */
function serve(status: number, body: string, contentType = "application/json") {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requestCount += 1;
      lastRequest = {
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    });
  });
  return listen();
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
  requestCount = 0;
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

const list = (apiKey: string | null = "sk-test-key-a91c") =>
  createOpenAiCompatibleClient({ baseUrl, model: "test-model", apiKey }).listModels({
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

describe("vendor headers", () => {
  it("authenticates Anthropic the way its own API expects", () => {
    // Its chat route takes a bearer; /v1/models is the native API and takes
    // x-api-key, so a good key was being reported as `401 Invalid bearer
    // token` the moment anyone tried to list models.
    expect(vendorHeaders("https://api.anthropic.com/v1", "sk-ant-key")).toEqual({
      "x-api-key": "sk-ant-key",
      "anthropic-version": "2023-06-01",
    });
  });

  it("adds nothing for anyone else, including a lookalike host", () => {
    expect(vendorHeaders("https://api.openai.com/v1", "sk-key")).toEqual({});
    // Not a substring match: the key must not be handed to a host that merely
    // contains the vendor's name.
    expect(vendorHeaders("https://api.anthropic.com.evil.test/v1", "sk-key")).toEqual({});
  });

  it("adds nothing when there is no key to send", () => {
    expect(vendorHeaders("https://api.anthropic.com/v1", null)).toEqual({});
  });

  it("does not throw on a base URL that is not a URL", () => {
    expect(vendorHeaders("not a url", "sk-key")).toEqual({});
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

  it("separates an empty account from a rate limit, though both are 429", async () => {
    // Observed against the real provider: an account with no credits answers
    // 429. Calling that a rate limit would have every caller back off and
    // retry something that cannot succeed until a human pays a bill.
    await serve(
      429,
      JSON.stringify({
        error: {
          message: "You have no credits remaining. Add credits to continue.",
          type: "insufficient_quota",
        },
      }),
    );
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("quota");
    expect(out.ok === false && out.error.message).toContain("no credits remaining");
  });

  it("maps 402 to quota, which is where some gateways put it", async () => {
    await serve(402, JSON.stringify({ error: { message: "payment required" } }));
    const out = await call();
    expect(out.ok === false && out.error.kind).toBe("quota");
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

/**
 * The one place the OpenAI-compatible shape actually forked.
 *
 * `max_tokens` is what vLLM, Ollama and llama.cpp accept and what OpenAI
 * accepted for years; OpenAI's newer models reject it and name the
 * replacement. Found by pointing the settings screen at a real key rather than
 * by reading a changelog, which is the whole argument for the test call.
 */
describe("the max_tokens fork", () => {
  const sent: string[] = [];

  /** Refuses `max_tokens` exactly as the live endpoint did. */
  function servePicky() {
    sent.length = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        sent.push(body);
        if ((JSON.parse(body) as Record<string, unknown>).max_tokens !== undefined) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this " +
                  "model. Use 'max_completion_tokens' instead.",
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(OK_BODY);
      });
    });
    return listen();
  }

  it("asks again the way the endpoint said it wanted to be asked", async () => {
    await servePicky();
    const out = await call();

    expect(out.ok).toBe(true);
    expect(out.ok && out.text).toBe("ready");
    expect(sent).toHaveLength(2);
    // The cap survives the swap: retrying without it would let a test call
    // bill for a full-length completion.
    expect(JSON.parse(sent[0]!).max_tokens).toBe(16);
    expect(JSON.parse(sent[1]!).max_completion_tokens).toBe(16);
    expect(JSON.parse(sent[1]!).max_tokens).toBeUndefined();
  });

  it("does not retry a 400 that named something else", async () => {
    await serve(400, JSON.stringify({ error: { message: "bad temperature" } }));
    const out = await call();
    // One request, one answer. A blanket retry-on-400 would double every
    // failing call, including the ones that fail for a reason we understand.
    expect(out.ok === false && out.error.kind).toBe("unknown");
    expect(requestCount).toBe(1);
  });

  it("sends nothing to retry when no cap was asked for", async () => {
    await servePicky();
    const out = await createOpenAiCompatibleClient({
      baseUrl,
      model: "test-model",
      apiKey: null,
    }).complete({ messages: [{ role: "user", content: "hi" }], timeoutMs: 5_000 });

    expect(out.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

/**
 * Model discovery. The cases that matter are the ones where the endpoint
 * cannot answer: a picker is only worth having if failing to build one leaves
 * the user typing a name rather than staring at an error.
 */
describe("listing models", () => {
  const LIST_BODY = JSON.stringify({
    object: "list",
    data: [
      { id: "gpt-4o", object: "model" },
      { id: "gpt-4o-mini", object: "model" },
      { id: "gpt-4o", object: "model" },
      { id: "", object: "model" },
      { object: "model" },
    ],
  });

  it("GETs <base>/models with the bearer token", async () => {
    await serve(200, LIST_BODY);
    await list();
    expect(lastRequest?.url).toBe("/v1/models");
    expect(lastRequest?.headers.authorization).toBe("Bearer sk-test-key-a91c");
    // A GET carries no body, so it must not claim to.
    expect(lastRequest?.headers["content-type"]).toBeUndefined();
  });

  it("returns the ids, deduplicated, sorted, and without the blanks", async () => {
    await serve(200, LIST_BODY);
    const out = await list();
    expect(out.ok).toBe(true);
    // Entries with no usable id are dropped rather than rendered as empty rows
    // in a picker.
    expect(out.ok && out.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("accepts the bare array some gateways return", async () => {
    await serve(200, JSON.stringify([{ id: "mixtral" }, "llama3.1"]));
    const out = await list();
    expect(out.ok && out.models).toEqual(["llama3.1", "mixtral"]);
  });

  it("treats an empty list as a success, not a failure", async () => {
    // The endpoint answered honestly; it just serves nothing it will name.
    await serve(200, JSON.stringify({ object: "list", data: [] }));
    const out = await list();
    expect(out.ok && out.models).toEqual([]);
  });

  it("calls a 404 unsupported rather than a missing model", async () => {
    // The single most common case: a runtime that serves completions and has
    // no listing route at all. On the completion path this same status means
    // "no such model", which is why the mapping is not shared.
    await serve(404, "not found", "text/plain");
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("unsupported");
    expect(out.ok === false && out.error.message).toMatch(/does not list/);
  });

  it("calls a 405 unsupported too", async () => {
    await serve(405, "method not allowed", "text/plain");
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("unsupported");
  });

  it("separates an empty account from a rate limit here too", async () => {
    await serve(429, JSON.stringify({ error: { type: "insufficient_quota" } }));
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("quota");
  });

  it("reports a rejected key as auth, since that is worth fixing", async () => {
    await serve(401, JSON.stringify({ error: { message: "Invalid API key" } }));
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("auth");
    expect(out.ok === false && out.error.message).toContain("Invalid API key");
  });

  it("calls JSON that is not a list unsupported", async () => {
    await serve(200, JSON.stringify({ hello: "world" }));
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("unsupported");
  });

  it("reports non-JSON as a protocol error, since the base URL is wrong", async () => {
    // Not "cannot enumerate": the completion call is about to fail the same
    // way, and saying so here is what stops the user saving a broken URL.
    await serve(200, "<html>hello</html>", "text/html");
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("protocol");
  });

  it("sends no Authorization header when there is no key", async () => {
    await serve(200, LIST_BODY);
    await list(null);
    expect(lastRequest?.headers.authorization).toBeUndefined();
  });

  it("refuses a blocked address before making any request", async () => {
    await serve(200, LIST_BODY);
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    const out = await list();
    expect(out.ok === false && out.error.kind).toBe("blocked");
    expect(lastRequest).toBeNull();
    delete process.env.SPECBOARDS_MULTI_TENANT;
  });
});

/**
 * Why a request never got a reply.
 *
 * undici reports every connection failure as the bare string "fetch failed"
 * and puts the real error on `cause`. Passing that through was telling users
 * nothing at the exact moment they most needed a direction to look in: a
 * refused port, an unresolvable host and an untrusted certificate all read
 * identically, and only one of them is a firewall problem.
 */
describe("the reason a connection failed", () => {
  const wrapped = (code: string, message: string) =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(message), { code }),
    });

  it("unwraps the cause rather than reporting 'fetch failed'", () => {
    const reason = transportReason(wrapped("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:8000"));
    expect(reason).toContain("ECONNREFUSED");
    expect(reason).not.toBe("fetch failed");
  });

  it("names the fix for a certificate a private authority signed", () => {
    // The on-prem case. Without this the operator goes looking at the network.
    expect(transportReason(wrapped("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain")))
      .toContain("SPECBOARDS_MODEL_CA_CERT");
  });

  it("does not offer a certificate to trust when the certificate expired", () => {
    // Trusting a new authority cannot fix an expired certificate, and saying
    // so would send someone to configure a variable that will not help.
    const reason = transportReason(wrapped("CERT_HAS_EXPIRED", "certificate has expired"));
    expect(reason).toContain("expired");
    expect(reason).not.toContain("SPECBOARDS_MODEL_CA_CERT");
  });

  it("still says something when there is no cause to unwrap", () => {
    expect(transportReason(new Error("socket hang up"))).toBe("socket hang up");
    expect(transportReason("not an error at all")).toBe("request failed");
  });
});

/**
 * What an air-gapped install can be told.
 *
 * `docs/GUIDE-self-hosted-model.md` tells customers with no outbound internet
 * that the inference path reaches exactly one address, the one they entered.
 * That is a claim about this adapter, so it is asserted here rather than left
 * to a future contributor's judgement about whether a telemetry ping or a
 * vendor model-list fetch is harmless.
 */
describe("what a call reaches", () => {
  it("makes exactly one request, to the configured endpoint", async () => {
    await serve(200, OK_BODY);
    const out = await call();

    expect(out.ok).toBe(true);
    expect(requestCount).toBe(1);
    expect(lastRequest?.url).toBe("/v1/chat/completions");
  });

  it("asks the configured endpoint for its models, not a vendor", async () => {
    await serve(200, JSON.stringify({ data: [{ id: "local-model" }] }));
    await list();

    expect(requestCount).toBe(1);
    expect(lastRequest?.url).toBe("/v1/models");
  });
});

/**
 * SSE framing, as pure functions.
 *
 * This is the part of streaming most likely to be quietly wrong. A chunk
 * boundary falls wherever TCP puts it, routinely mid-line and mid-JSON, and a
 * parser that assumes one network chunk is one event works perfectly against a
 * fast local runtime and drops or corrupts frames from a slow remote one. That
 * failure is invisible in a demo and shows up as answers with holes in them.
 */
describe("reading a server-sent event stream", () => {
  it("returns complete data lines and holds back the rest", () => {
    const { data, rest } = sseDataLines('data: {"a":1}\n\ndata: {"b":2');
    expect(data).toEqual(['{"a":1}']);
    // The half-arrived line is kept, not parsed and not lost.
    expect(rest).toBe('data: {"b":2');
  });

  it("reassembles a frame split across two chunks", () => {
    const first = sseDataLines('data: {"choices":[{"delta":{"con');
    expect(first.data).toEqual([]);
    const second = sseDataLines(`${first.rest}tent":"hi"}}]}\n\n`);
    expect(second.data).toHaveLength(1);
    expect(streamChunkFrom(second.data[0]!)?.text).toBe("hi");
  });

  it("accepts CRLF line endings", () => {
    const { data } = sseDataLines('data: {"a":1}\r\n\r\n');
    expect(data).toEqual(['{"a":1}']);
  });

  it("ignores keepalive comments and other fields", () => {
    // Gateways send `:` comments to hold an idle connection open, and some
    // send `event:` lines. Parsing either as content would inject junk into
    // the answer.
    const { data } = sseDataLines(': keep-alive\nevent: message\ndata: {"a":1}\n\n');
    expect(data).toEqual(['{"a":1}']);
  });

  it("treats the DONE sentinel as no chunk rather than as text", () => {
    expect(streamChunkFrom("[DONE]")).toBeNull();
  });

  it("drops a malformed frame instead of failing the answer", () => {
    // The endpoint has already sent real text by this point. Losing one frame
    // degrades the answer; throwing would lose all of it.
    expect(streamChunkFrom("{not json")).toBeNull();
  });

  it("reads the model and usage off a frame that carries them", () => {
    const chunk = streamChunkFrom(
      JSON.stringify({
        model: "served-model",
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
    );
    expect(chunk?.model).toBe("served-model");
    expect(chunk?.usage?.totalTokens).toBe(7);
    expect(chunk?.text).toBeNull();
  });
});

/** Serve an SSE stream, one frame per entry, then `[DONE]`. */
function serveStream(frames: unknown[], opts: { holdOpen?: boolean } = {}) {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      requestCount += 1;
      lastRequest = {
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (opts.holdOpen) return; // never finishes; the caller must cancel
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return listen();
}

const streamCall = (signal?: AbortSignal) =>
  createOpenAiCompatibleClient({
    baseUrl,
    model: "test-model",
    apiKey: "sk-test-key-a91c",
  }).stream({
    messages: [{ role: "user", content: "hi" }],
    timeoutMs: 5_000,
    ...(signal ? { signal } : {}),
  });

async function drain(signal?: AbortSignal) {
  const deltas: string[] = [];
  let done: { usage: TokenUsage; model: string | null } | null = null;
  let error: ModelError | null = null;
  for await (const event of streamCall(signal)) {
    if (event.kind === "delta") deltas.push(event.text);
    else if (event.kind === "done") done = { usage: event.usage, model: event.model };
    else error = event.error;
  }
  return { deltas, text: deltas.join(""), done, error };
}

describe("streaming a completion", () => {
  it("delivers the answer in pieces and then finishes", async () => {
    await serveStream([
      { model: "served-model", choices: [{ delta: { content: "Hello" } }] },
      { model: "served-model", choices: [{ delta: { content: ", world" } }] },
      {
        model: "served-model",
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);

    const out = await drain();
    expect(out.deltas).toEqual(["Hello", ", world"]);
    expect(out.done?.model).toBe("served-model");
    expect(out.done?.usage.totalTokens).toBe(7);
    expect(out.error).toBeNull();
  });

  it("asks for usage on the final frame", async () => {
    await serveStream([{ choices: [{ delta: { content: "x" } }] }]);
    await drain();
    const body = JSON.parse(lastRequest!.body) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    // Without this OpenAI reports no usage at all on a stream, and the
    // assistant would store a turn whose cost is permanently unknown.
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("retries without stream_options when the endpoint rejects it", async () => {
    // Negotiated from what the server says, the same way the max_tokens fork
    // is: a runtime that has never heard of stream_options must still work,
    // and guessing which ones those are is a list we would maintain forever.
    let seen = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        requestCount += 1;
        lastRequest = {
          url: req.url ?? "",
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        seen += 1;
        if (seen === 1) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "unknown field: stream_options" },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await listen();

    const out = await drain();
    expect(out.text).toBe("ok");
    expect(requestCount).toBe(2);
    expect(JSON.parse(lastRequest!.body).stream_options).toBeUndefined();
  });

  it("reports a refused key as an error event, not a throw", async () => {
    await serve(401, JSON.stringify({ error: { message: "bad key" } }));
    const out = await drain();
    expect(out.deltas).toEqual([]);
    expect(out.error?.kind).toBe("auth");
    expect(out.done).toBeNull();
  });

  it("reports a stream that says nothing at all", async () => {
    // An endpoint that opens a stream and closes it having sent no content is
    // not answering with an empty string; it is not doing what it claimed.
    // Rendering that as a blank reply gives the user nothing to act on.
    await serveStream([]);
    const out = await drain();
    expect(out.error?.kind).toBe("protocol");
  });

  it("ends silently when the caller cancels", async () => {
    await serveStream([{ choices: [{ delta: { content: "partial" } }] }], {
      holdOpen: true,
    });
    const controller = new AbortController();
    const deltas: string[] = [];
    let terminal: string | null = null;
    for await (const event of streamCall(controller.signal)) {
      if (event.kind === "delta") {
        deltas.push(event.text);
        controller.abort();
      } else terminal = event.kind;
    }

    expect(deltas).toEqual(["partial"]);
    // No terminal event at all: that absence is how a consumer tells "stopped
    // on request" from "finished" and from "broke".
    expect(terminal).toBeNull();
  });
});
