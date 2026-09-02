import { describe, expect, it } from "vitest";

import { clampReleaseTarget } from "./releases-service";

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
