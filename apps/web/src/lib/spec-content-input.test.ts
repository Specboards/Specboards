import { describe, expect, it } from "vitest";

import { InvalidPatchError, parseSpecContentInput } from "./features-service";

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

  it("rejects a non-object body", () => {
    expect(() => parseSpecContentInput(null)).toThrow(InvalidPatchError);
    expect(() => parseSpecContentInput("body")).toThrow(InvalidPatchError);
    expect(() => parseSpecContentInput([{ content: "body" }])).toThrow(
      InvalidPatchError,
    );
  });
});
