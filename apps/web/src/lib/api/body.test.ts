import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BODY_BYTES, readJsonBody, readTextBodyWithin } from "./body";

const URL = "https://example.test/api/v1/thing";

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", body, headers });
}

/**
 * A chunked request: a body stream with no `Content-Length`, which is how a
 * client bypasses the header fast path.
 *
 * Chunks are produced in `pull`, one per demand, so `sent` measures what the
 * reader actually asked for. Enqueuing them all up front in `start` would count
 * bytes nobody read and prove nothing about when the reader stopped.
 */
function chunkedReq(chunks: string[]): { req: Request; sent: () => number } {
  let sent = 0;
  let index = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const bytes = encoder.encode(chunks[index]!);
      index += 1;
      sent += bytes.byteLength;
      controller.enqueue(bytes);
    },
  });
  const req = new Request(URL, {
    method: "POST",
    body,
    // Required by undici to send a stream body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { req, sent: () => sent };
}

describe("readJsonBody", () => {
  it("parses a well-formed JSON body", async () => {
    const parsed = await readJsonBody(jsonReq(JSON.stringify({ a: 1 })));
    expect(parsed).toEqual({ ok: true, body: { a: 1 } });
  });

  it("returns 400 on invalid JSON", async () => {
    const parsed = await readJsonBody(jsonReq("{not json"));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.response.status).toBe(400);
    expect(await parsed.response.json()).toEqual({ error: "Request body must be JSON." });
  });

  it("rejects with 413 when Content-Length exceeds the limit, before reading", async () => {
    // A lying header far over the limit is rejected on the fast path even though
    // the actual body is tiny.
    const req = jsonReq(JSON.stringify({ a: 1 }), {
      "content-length": String(DEFAULT_MAX_BODY_BYTES + 1),
    });
    const parsed = await readJsonBody(req);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.response.status).toBe(413);
  });

  it("rejects with 413 on the byte-length backstop when no Content-Length is present", async () => {
    // Body over a small explicit limit; the header path is skipped so the
    // post-read byte check must catch it.
    const big = JSON.stringify({ pad: "x".repeat(200) });
    const req = new Request(URL, { method: "POST", body: big });
    req.headers.delete("content-length");
    const parsed = await readJsonBody(req, { limit: 50 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.response.status).toBe(413);
  });

  it("counts bytes, not UTF-16 code units, for multibyte content", async () => {
    // Four-byte emoji: one JSON string char but several bytes. A byte limit
    // just above the code-unit length must still reject it.
    const body = JSON.stringify("😀😀😀😀😀😀😀😀😀😀");
    const parsed = await readJsonBody(jsonReq(body), { limit: body.length + 2 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected failure");
    expect(parsed.response.status).toBe(413);
  });

  it("honors a narrower per-route limit", async () => {
    const parsed = await readJsonBody(jsonReq(JSON.stringify({ a: "x".repeat(100) })), {
      limit: 10,
    });
    expect(parsed.ok).toBe(false);
  });
});

/**
 * The raw-text reader the MCP and GitHub webhook routes use. Both of those had
 * their own `await req.text()` + `raw.length` check, so the cap bounded the
 * response rather than the allocation, and counted UTF-16 code units against a
 * byte limit.
 */
describe("readTextBodyWithin", () => {
  it("returns the body unchanged when it fits", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
    expect(await readTextBodyWithin(jsonReq(body), 1000, "test")).toBe(body);
  });

  it("rejects on Content-Length before reading a byte", async () => {
    const req = jsonReq("{}", { "content-length": "999999" });
    expect(await readTextBodyWithin(req, 100, "test")).toBeNull();
  });

  it("stops reading a chunked body instead of buffering all of it", async () => {
    // The actual finding: no Content-Length, so the header path cannot help.
    // 20 chunks of 100 bytes against a 250-byte limit must not consume 2000.
    const { req, sent } = chunkedReq(Array.from({ length: 20 }, () => "x".repeat(100)));
    expect(await readTextBodyWithin(req, 250, "test")).toBeNull();
    // At most limit + one chunk is pulled. Asserted as a bound rather than an
    // exact figure: what matters is that it is not the whole body.
    expect(sent()).toBeLessThanOrEqual(250 + 100);
    expect(sent()).toBeLessThan(2000);
  });

  it("counts bytes, not UTF-16 code units", async () => {
    // 10 four-byte emoji: 20 code units, 40 bytes. A 30-byte limit must reject,
    // where `raw.length > limit` would have let it through.
    const body = "😀".repeat(10);
    expect(body.length).toBe(20);
    expect(new TextEncoder().encode(body).byteLength).toBe(40);
    expect(await readTextBodyWithin(jsonReq(body), 30, "test")).toBeNull();
  });

  it("does not mangle a multibyte character split across chunks", async () => {
    // The reason the decoder is incremental: half an emoji at a chunk boundary
    // must not decode to U+FFFD. Split one 4-byte character down the middle.
    const encoded = new TextEncoder().encode("a😀b");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 3));
        controller.enqueue(encoded.slice(3));
        controller.close();
      },
    });
    const req = new Request(URL, { method: "POST", body: stream, duplex: "half" } as
      RequestInit & { duplex: "half" });
    expect(await readTextBodyWithin(req, 1000, "test")).toBe("a😀b");
  });

  it("treats a body exactly at the limit as acceptable", async () => {
    const body = "x".repeat(64);
    expect(await readTextBodyWithin(jsonReq(body), 64, "test")).toBe(body);
    expect(await readTextBodyWithin(jsonReq(body), 63, "test")).toBeNull();
  });

  it("returns empty string for a request with no body", async () => {
    expect(await readTextBodyWithin(new Request(URL), 100, "test")).toBe("");
  });
});
