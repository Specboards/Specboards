import { describe, expect, it } from "vitest";

import { sameEndpoint } from "./endpoint";

/**
 * One rule, two callers: the settings form decides whether to ask for the key
 * again, and the server decides whether to refuse the save. They have to agree,
 * or the form promises a save that the server then rejects on a security
 * control the user cannot see.
 */
describe("sameEndpoint", () => {
  it("ignores a trailing slash", () => {
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.openai.com/v1/")).toBe(
      true,
    );
    expect(sameEndpoint("https://api.openai.com/v1///", "https://api.openai.com/v1")).toBe(
      true,
    );
  });

  it("ignores surrounding whitespace", () => {
    expect(sameEndpoint("  https://api.openai.com/v1  ", "https://api.openai.com/v1")).toBe(
      true,
    );
  });

  it("ignores the case of the scheme and host", () => {
    expect(sameEndpoint("HTTPS://API.OpenAI.com/v1", "https://api.openai.com/v1")).toBe(
      true,
    );
  });

  it("treats a different host, port or path as a different endpoint", () => {
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.groq.com/v1")).toBe(false);
    expect(sameEndpoint("http://127.0.0.1:11434/v1", "http://127.0.0.1:8000/v1")).toBe(
      false,
    );
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.openai.com/v2")).toBe(
      false,
    );
  });

  // The whole normalised URL is lowercased, so path case does not distinguish
  // two endpoints either. Deliberate, and safe for what this decides: the host
  // is what determines who receives the key, and `/V1` and `/v1` on one host
  // are the same party. A case-sensitive gateway serving different content at
  // the two would still get the key it was already given.
  it("does not distinguish endpoints by path case", () => {
    expect(sameEndpoint("https://gw.example.com/V1", "https://gw.example.com/v1")).toBe(
      true,
    );
  });

  it("compares an unparseable value as a plain string", () => {
    expect(sameEndpoint("not a url", "not a url")).toBe(true);
    expect(sameEndpoint("not a url", "https://api.openai.com/v1")).toBe(false);
    // A half-typed endpoint must never come out equal to a real one.
    expect(sameEndpoint("https://", "https://api.openai.com/v1")).toBe(false);
  });

  it("treats an empty string as different from any real endpoint", () => {
    expect(sameEndpoint("", "https://api.openai.com/v1")).toBe(false);
  });
});
