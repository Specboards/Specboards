import { describe, expect, it } from "vitest";

import {
  clampReleaseTarget,
  parseCreateFeatureInput,
} from "./features-service";

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

  it("accepts a non-UUID productId (local file mode uses stable keys)", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      productId: "default",
    });
    expect(input.productId).toBe("default");
  });

  it("treats an empty-string productId as unset", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      productId: "",
    });
    expect(input.productId).toBeUndefined();
  });

  it("rejects a non-string productId", () => {
    expect(() =>
      parseCreateFeatureInput({ title: "A", level: "epic", productId: 5 }),
    ).toThrow(/productId/);
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

  // The level's detail template is seeded on create only when the caller says
  // nothing about details, so these two cases must stay distinguishable.
  it("leaves details undefined when the key is absent (template applies)", () => {
    const input = parseCreateFeatureInput({ title: "A", level: "epic" });
    expect(input.details).toBeUndefined();
  });

  it("keeps an explicit null details (create blank, no template)", () => {
    const input = parseCreateFeatureInput({
      title: "A",
      level: "epic",
      details: null,
    });
    expect(input.details).toBeNull();
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

describe("clampReleaseTarget", () => {
  it("pulls the ship date along when the start moves past it", () => {
    expect(
      clampReleaseTarget({ startDate: "2026-08-10" }, { targetDate: "2026-08-01" }),
    ).toEqual({ startDate: "2026-08-10", targetDate: "2026-08-10" });
  });

  it("leaves a start that still precedes the ship date alone", () => {
    expect(
      clampReleaseTarget({ startDate: "2026-07-20" }, { targetDate: "2026-08-01" }),
    ).toEqual({ startDate: "2026-07-20" });
  });

  it("treats an equal start and ship date as valid (a one-day release)", () => {
    expect(
      clampReleaseTarget({ startDate: "2026-08-01" }, { targetDate: "2026-08-01" }),
    ).toEqual({ startDate: "2026-08-01" });
  });

  it("clamps against the patch's own ship date when both move", () => {
    expect(
      clampReleaseTarget(
        { startDate: "2026-09-01", targetDate: "2026-08-01" },
        { targetDate: "2026-12-01" },
      ),
    ).toEqual({ startDate: "2026-09-01", targetDate: "2026-09-01" });
  });

  it("respects a patch that sets both dates in order", () => {
    const patch = { startDate: "2026-09-01", targetDate: "2026-09-30" };
    expect(clampReleaseTarget(patch, { targetDate: "2026-08-01" })).toEqual(patch);
  });

  it("does nothing when the release has no ship date to pull", () => {
    expect(
      clampReleaseTarget({ startDate: "2026-08-10" }, { targetDate: null }),
    ).toEqual({ startDate: "2026-08-10" });
  });

  it("does nothing when the patch clears the start or leaves it alone", () => {
    const before = { targetDate: "2026-08-01" };
    expect(clampReleaseTarget({ startDate: null }, before)).toEqual({
      startDate: null,
    });
    expect(clampReleaseTarget({ name: "v1" }, before)).toEqual({ name: "v1" });
  });

  it("never moves the ship date earlier", () => {
    expect(
      clampReleaseTarget({ startDate: "2026-01-01" }, { targetDate: "2026-08-01" }),
    ).toEqual({ startDate: "2026-01-01" });
  });
});
