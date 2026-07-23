import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BODY_BYTES, readJsonBody } from "./body";

const URL = "https://example.test/api/v1/thing";

function jsonReq(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", body, headers });
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
