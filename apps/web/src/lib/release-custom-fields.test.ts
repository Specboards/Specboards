import { describe, expect, it } from "vitest";

import {
  InvalidPatchError,
  parsePropertyInput,
  parseReleaseInput,
  parseReleasePatch,
} from "./features-service";

describe("parsePropertyInput - entity scope", () => {
  it("defaults entity to undefined (store treats as 'item')", () => {
    const input = parsePropertyInput({ label: "Effort", type: "number" });
    expect(input.entity).toBeUndefined();
  });

  it("accepts an explicit release entity", () => {
    const input = parsePropertyInput({
      label: "Release manager",
      type: "user",
      entity: "release",
    });
    expect(input.entity).toBe("release");
  });

  it("ignores levels for a release-scoped property", () => {
    const input = parsePropertyInput({
      label: "Risk",
      type: "select",
      entity: "release",
      levels: ["feature"],
    });
    expect(input.levels).toBeUndefined();
  });

  it("keeps levels for an item-scoped property", () => {
    const input = parsePropertyInput({
      label: "Team",
      type: "text",
      entity: "item",
      levels: ["epic", "feature"],
    });
    expect(input.levels).toEqual(["epic", "feature"]);
  });

  it("rejects an unknown entity", () => {
    expect(() =>
      parsePropertyInput({ label: "X", type: "text", entity: "project" }),
    ).toThrow(InvalidPatchError);
  });
});

describe("release customFields parsing", () => {
  it("parses customFields on create", () => {
    const input = parseReleaseInput({
      name: "v1.0",
      customFields: { risk: "high", owners: ["a", "b"], count: 3 },
    });
    expect(input.customFields).toEqual({
      risk: "high",
      owners: ["a", "b"],
      count: 3,
    });
  });

  it("counts customFields as a real change on patch", () => {
    expect(() =>
      parseReleasePatch({ customFields: { risk: "low" } }),
    ).not.toThrow();
  });

  it("rejects a non-object customFields", () => {
    expect(() =>
      parseReleasePatch({ customFields: "nope" }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a customField value of the wrong shape", () => {
    expect(() =>
      parseReleaseInput({ name: "v1", customFields: { bad: { nested: 1 } } }),
    ).toThrow(InvalidPatchError);
  });
});
