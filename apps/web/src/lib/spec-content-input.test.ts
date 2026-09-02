import { describe, expect, it } from "vitest";

import { InvalidPatchError } from "./service-errors";
import { parseSpecContentInput } from "./specs-service";

describe("parseSpecContentInput", () => {
  it("accepts a body with content only", () => {
    expect(parseSpecContentInput({ content: "# Spec\n" })).toEqual({
      content: "# Spec\n",
    });
  });

  it("keeps a commit message when one is given", () => {
    expect(
      parseSpecContentInput({ content: "body", message: "docs: tighten scope" }),
    ).toEqual({ content: "body", message: "docs: tighten scope" });
  });

  it("drops a blank message so the generated one is used", () => {
    expect(parseSpecContentInput({ content: "body", message: "   " })).toEqual({
      content: "body",
    });
    expect(parseSpecContentInput({ content: "body", message: null })).toEqual({
      content: "body",
    });
  });

  it("accepts empty content: clearing a spec back to a stub is a real edit", () => {
    expect(parseSpecContentInput({ content: "" })).toEqual({ content: "" });
  });

  it("rejects a missing or non-string content", () => {
    expect(() => parseSpecContentInput({})).toThrow(InvalidPatchError);
    expect(() => parseSpecContentInput({ content: 42 })).toThrow(
      InvalidPatchError,
    );
    expect(() => parseSpecContentInput({ content: null })).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects a non-string message", () => {
    expect(() =>
      parseSpecContentInput({ content: "body", message: 7 }),
    ).toThrow(InvalidPatchError);
  });

  it("keeps the loaded blob sha, which is what arms the guard", () => {
    expect(
      parseSpecContentInput({ content: "body", expectedBlobSha: "abc123" }),
    ).toEqual({ content: "body", expectedBlobSha: "abc123" });
  });

  it("treats an absent sha as an unguarded write rather than an error", () => {
    // An agent composing a body has no loaded copy to guard against, and
    // refusing its write would be refusing the API's oldest caller.
    expect(
      parseSpecContentInput({ content: "body", expectedBlobSha: null }),
    ).toEqual({ content: "body" });
  });

  it("rejects a blank sha instead of quietly dropping the guard", () => {
    // Dropping it would turn a write the caller believes is guarded into one
    // that is not, which is the exact failure the guard exists to prevent.
    expect(() =>
      parseSpecContentInput({ content: "body", expectedBlobSha: "  " }),
    ).toThrow(InvalidPatchError);
    expect(() =>
      parseSpecContentInput({ content: "body", expectedBlobSha: 7 }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a non-object body", () => {
    expect(() => parseSpecContentInput(null)).toThrow(InvalidPatchError);
    expect(() => parseSpecContentInput("body")).toThrow(InvalidPatchError);
    expect(() => parseSpecContentInput([{ content: "body" }])).toThrow(
      InvalidPatchError,
    );
  });
});
