import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, SpecboardsClient } from "./client.js";

/**
 * The CLI's request contract. `status --advance` used to walk the stage chain
 * here, one PATCH per hop; the walk moved server-side so the MCP tools and REST
 * share it, which makes `?advance=1` the CLI's whole side of that feature. It is
 * worth pinning: drop the flag and a strict workspace silently starts rejecting
 * every multi-stage move again.
 */
describe("SpecboardsClient.patchFeature", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ok({ feature: { status: "in_review" } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client() {
    return new SpecboardsClient("https://app.example.com/", "sb_key", "acme");
  }

  it("asks the server to walk the chain when advance is set", async () => {
    await client().patchFeature("spec-1", { status: "in_review" }, { advance: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://app.example.com/api/v1/features/spec-1?advance=1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(init.body as string)).toEqual({ status: "in_review" });
  });

  it("sends no advance param by default, so a single step stays a single step", async () => {
    await client().patchFeature("spec-1", { status: "defining" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://app.example.com/api/v1/features/spec-1",
    );
  });

  it("encodes the spec id into the path", async () => {
    await client().patchFeature("a/b c", { status: "done" }, { advance: true });
    expect(fetchMock.mock.calls[0]![0]).toContain("/features/a%2Fb%20c?advance=1");
  });

  it("sends auth and org headers", async () => {
    await client().patchFeature("spec-1", { status: "done" });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: {
        "x-api-key": "sb_key",
        "x-org-slug": "acme",
        "content-type": "application/json",
      },
    });
  });

  it("surfaces the server's message for a rejected transition", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: "Illegal transition: backlog -> done." }),
          { status: 422 },
        ),
    );
    const rejects = expect(
      client().patchFeature("spec-1", { status: "done" }),
    ).rejects;
    await rejects.toThrow(/Illegal transition/);
    await expect(
      client().patchFeature("spec-1", { status: "done" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
