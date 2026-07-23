import { describe, expect, it } from "vitest";

import { parseCreateFeatureInput } from "./features-service";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("parseCreateFeatureInput", () => {
  it("accepts a minimal valid body", () => {
    expect(parseCreateFeatureInput({ title: "A", level: "epic" })).toEqual({
      title: "A",
      level: "epic",
    });
  });

  it("accepts a releaseId when it is a UUID", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      releaseId: UUID,
    });
    expect(input.releaseId).toBe(UUID);
  });

  it("ignores a null releaseId (leaves it unscheduled)", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      releaseId: null,
    });
    expect(input.releaseId).toBeUndefined();
  });

  it("rejects a non-UUID releaseId", () => {
    expect(() =>
      parseCreateFeatureInput({ title: "A", level: "epic", releaseId: "nope" }),
    ).toThrow(/releaseId/);
  });

  it("accepts a valid customFields map", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      customFields: { risk: "high", points: 3, owners: ["a", "b"] },
    });
    expect(input.customFields).toEqual({
      risk: "high",
      points: 3,
      owners: ["a", "b"],
    });
  });

  it("rejects customFields with a non-scalar value", () => {
    expect(() =>
      parseCreateFeatureInput({
        title: "A",
        level: "epic",
        customFields: { bad: { nested: true } },
      }),
    ).toThrow(/customFields/);
  });
});
