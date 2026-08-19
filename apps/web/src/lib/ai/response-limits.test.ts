import { describe, expect, it } from "vitest";

import {
  MAX_RESPONSE_BYTES,
  MAX_SSE_LINE_BYTES,
  MAX_STREAM_BYTES,
  MAX_STREAM_MS,
  describeStreamLimit,
  readResponseTextWithin,
  streamLimitExceeded,
} from "./response-limits";

/**
 * What a model endpoint is allowed to send back.
 *
 * The endpoint is named by an org owner and passes the egress guard by being a
 * genuinely public address, so "it is our customer's own server" is not a
 * reason to trust its output. Inbound bodies have been byte-capped since
 * `lib/api/body.ts`; these are the same policy pointed the other way.
 *
 * The ceilings live here as a pure decision so all three can be asserted
 * exactly, including the wall-clock one, which would otherwise need a
 * ten-minute test. `openai-compatible.test.ts` proves the wiring against a real
 * server.
 */

/** A response whose body arrives in `chunks`, metered like a real one. */
function streamed(chunks: Uint8Array[]) {
  let i = 0;
  let cancelled = false;
  return {
    cancelled: () => cancelled,
    res: {
      body: {
        getReader() {
          return {
            read: async () =>
              i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
            cancel: async () => {
              cancelled = true;
            },
            releaseLock: () => {},
          };
        },
      },
      text: async () => chunks.map((c) => new TextDecoder().decode(c)).join(""),
    },
  };
}

const bytes = (n: number, fill = "a") => new TextEncoder().encode(fill.repeat(n));

describe("readResponseTextWithin", () => {
  it("returns a body that fits", async () => {
    const { res } = streamed([bytes(10), bytes(10)]);
    expect(await readResponseTextWithin(res, 100)).toBe("a".repeat(20));
  });

  it("refuses one that does not, and stops reading", async () => {
    const source = streamed([bytes(60), bytes(60), bytes(60)]);
    expect(await readResponseTextWithin(source.res, 100)).toBeNull();
    // Cancelled rather than drained: the point is to stop the allocation, not
    // to measure it after the fact.
    expect(source.cancelled()).toBe(true);
  });

  it("counts bytes, not UTF-16 code units", async () => {
    // An astral character is four bytes and two code units, so 30 of them are
    // 120 bytes that `.length` reports as 60. A limit named in bytes but
    // checked against `.length` lets twice its stated size through here, and up
    // to three times for a three-byte character in one code unit.
    const emoji = new TextEncoder().encode("🙂".repeat(30));
    expect(emoji.byteLength).toBe(120);
    expect(await readResponseTextWithin(streamed([emoji]).res, 100)).toBeNull();

    const under = await readResponseTextWithin(streamed([emoji]).res, 200);
    expect(under).toHaveLength(60);
    expect([...(under ?? "")].length).toBe(30);
  });

  it("decodes a character split across two chunks", async () => {
    const whole = new TextEncoder().encode("é");
    const { res } = streamed([whole.slice(0, 1), whole.slice(1)]);
    expect(await readResponseTextWithin(res, 100)).toBe("é");
  });

  it("falls back to reading whole when there is no stream to meter", async () => {
    const res = { body: null, text: async () => "short" };
    expect(await readResponseTextWithin(res, 100)).toBe("short");
    const big = { body: null, text: async () => "a".repeat(200) };
    expect(await readResponseTextWithin(big, 100)).toBeNull();
  });

  it("defaults to the response ceiling", async () => {
    const { res } = streamed([bytes(MAX_RESPONSE_BYTES + 1)]);
    expect(await readResponseTextWithin(res)).toBeNull();
  });
});

describe("streamLimitExceeded", () => {
  const ok = { bufferedChars: 0, streamedBytes: 0, elapsedMs: 0 };

  it("says nothing about a stream that is behaving", () => {
    expect(streamLimitExceeded(ok)).toBeNull();
    expect(
      streamLimitExceeded({
        bufferedChars: MAX_SSE_LINE_BYTES,
        streamedBytes: MAX_STREAM_BYTES,
        elapsedMs: MAX_STREAM_MS,
      }),
    ).toBeNull();
  });

  it("catches one enormous data line", () => {
    // The shape the review found: the parser holds the tail until a newline
    // arrives, so a body that never sends one grows without bound.
    expect(
      streamLimitExceeded({ ...ok, bufferedChars: MAX_SSE_LINE_BYTES + 1 }),
    ).toBe("line");
  });

  it("catches an endless trickle of well-formed chunks", () => {
    // Neither the line cap nor the idle timer sees this one: every chunk is
    // small, valid, and resets the clock.
    expect(streamLimitExceeded({ ...ok, streamedBytes: MAX_STREAM_BYTES + 1 })).toBe(
      "total",
    );
  });

  it("catches a stream that simply never ends", () => {
    expect(streamLimitExceeded({ ...ok, elapsedMs: MAX_STREAM_MS + 1 })).toBe("time");
  });

  it("describes each ceiling in terms of what the endpoint did", () => {
    for (const limit of ["line", "total", "time"] as const) {
      expect(describeStreamLimit(limit)).toMatch(/model endpoint/);
    }
  });
});

describe("the numbers themselves", () => {
  // Not arbitrary: each sits far above any legitimate answer and far below
  // anything that threatens a 512 MB machine shared with other tenants. This
  // asserts the ordering that makes them coherent rather than the values.
  it("bounds a single line below a whole stream", () => {
    expect(MAX_SSE_LINE_BYTES).toBeLessThan(MAX_STREAM_BYTES);
  });

  it("allows a streamed answer to be larger than a buffered one", () => {
    // A stream is delivered in pieces and never held whole here, so it can
    // afford a higher ceiling than a body read into one string.
    expect(MAX_RESPONSE_BYTES).toBeLessThan(MAX_STREAM_BYTES);
  });

  it("gives a stream longer than the idle timeout to finish", () => {
    // Otherwise the wall clock would fire on healthy long answers, which is
    // precisely what the idle-timeout design exists to avoid.
    expect(MAX_STREAM_MS).toBeGreaterThan(30_000);
  });
});
