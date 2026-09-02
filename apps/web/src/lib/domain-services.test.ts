import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The `/api/v1` domain layer stays split.
 *
 * This exists because the thing it guards against already happened once. Every
 * resource behind the public API (items, releases, cycles, goals, ideas,
 * levels, properties, templates, comments, notifications, workflow, specs,
 * work items, relations) validated and executed inside a single 2,579-line
 * `features-service.ts`, because at every point along the way that file was the
 * obvious place to add one more parser. Nothing objected until it was fourteen
 * resources deep.
 *
 * So the check is on the shape, not on anyone remembering. The layer is
 * discovered rather than listed: a module in this layer raises this layer's
 * errors, so importing `service-errors` is what makes a file one of these and
 * is what pulls it into the cap. A new resource is therefore covered the moment
 * it is written, and no list here can go stale by omission.
 *
 * If a module here is about to breach the cap, the fix is a new module rather
 * than a larger number. The cap is not a style preference: it is the distance
 * between the largest module today and the file this replaced.
 */

const LIB = join(import.meta.dirname, ".");

/** Roughly 20% above the largest module, and a fifth of the monolith. */
const MAX_LINES = 600;

const IMPORTS_ERRORS = /from "(?:@\/lib\/|\.\/)service-errors"/;

function domainServices(): { name: string; lines: number }[] {
  const out: { name: string; lines: number }[] = [];
  for (const name of readdirSync(LIB)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const text = readFileSync(join(LIB, name), "utf8");
    if (name !== "service-errors.ts" && !IMPORTS_ERRORS.test(text)) continue;
    out.push({ name, lines: text.split("\n").length });
  }
  return out;
}

describe("the /api/v1 domain layer", () => {
  it("is split across many modules rather than one", () => {
    // A floor, not a target. Its job is to fail if the discovery above ever
    // matches nothing (a rename, a move) and reports a green cap over an empty
    // set, which would read as "every module is small" while checking none.
    expect(domainServices().length).toBeGreaterThanOrEqual(15);
  });

  it("has no module large enough to be accreting a second resource", () => {
    const over = domainServices().filter((m) => m.lines > MAX_LINES);
    expect(over).toEqual([]);
  });
});
