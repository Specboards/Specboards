import { describe as report, MigrationGuidance } from "./migrate-errors";
import { describe, expect, it } from "vitest";

/**
 * What a failed migration actually says in the deploy log.
 *
 * This exists because of a defect found by the first end-to-end self-host
 * upgrade run. The runner composes a ten-line explanation for the one failure a
 * self-hoster is most likely to hit, ending with the only sentence that tells
 * them how to recover, and the log showed one line of it, ending in a comma.
 *
 * The formatter was right to clip, and clipping the wrong thing. A driver error
 * puts its summary on line one and everything useful in `detail` and `hint`, so
 * keeping the first line is correct there. A message we wrote IS the procedure,
 * so keeping the first line throws the procedure away.
 */

/** A postgres-js style failure: summary first, the useful parts in fields. */
function driverError(): Error {
  const err = new Error(
    'relation "features" does not exist\nsome noisy second line\nand a third',
  ) as Error & { code: string; hint: string };
  err.code = "42P01";
  err.hint = "Perhaps you meant to run the baseline first.";
  return err;
}

const GUIDANCE = new MigrationGuidance([
  "This database has applied migrations but is behind the squashed baseline,",
  "so there is no path from where it is to where this release expects it.",
  "",
  "To recover: deploy v1.0.1 (or any earlier release) against this database",
  "first and let it migrate to the end, then upgrade to this one. Nothing has",
  "been changed by this run.",
]);

describe("reporting a migration failure", () => {
  it("keeps every line of a message we wrote for the operator", () => {
    const text = report(GUIDANCE);
    // The recovery paragraph is the whole reason the message is long.
    expect(text).toContain("To recover: deploy v1.0.1");
    expect(text).toContain("Nothing has");
    // And it must not end mid-sentence, which is what the defect looked like.
    expect(text.trim().endsWith(",")).toBe(false);
  });

  it("still clips a driver error to its summary line", () => {
    // Not a regression to trade for the fix: a Postgres error's later lines are
    // noise, and its useful parts are picked up from `code` and `hint` below.
    const text = report(driverError());
    expect(text).toContain('relation "features" does not exist');
    expect(text).not.toContain("some noisy second line");
  });

  it("keeps the Postgres fields that carry the detail", () => {
    const text = report(driverError());
    expect(text).toContain("code 42P01");
    expect(text).toContain("Perhaps you meant to run the baseline first.");
  });

  it("unwraps a guidance error hidden inside a cause chain", () => {
    // Drizzle wraps what it catches. If the unwrapping ever stops reaching our
    // own error, the recovery text disappears again by a different route.
    const wrapper = new Error("Failed query: SELECT 1", { cause: GUIDANCE });
    const text = report(wrapper);
    expect(text).toContain("To recover: deploy v1.0.1");
  });

  it("falls back to something rather than nothing for a non-error", () => {
    expect(report("just a string")).toContain("just a string");
  });
});
