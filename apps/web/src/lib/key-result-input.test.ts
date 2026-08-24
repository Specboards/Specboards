import { describe, expect, it } from "vitest";

import { InvalidPatchError, parseKeyResultInput } from "@/lib/features-service";

/**
 * The untrusted-body parser for key results, where the yes-no rules live.
 *
 * The interesting cases are all about what a caller is allowed to leave out and
 * what happens to a value that is present but meaningless, because the parser
 * is the only thing standing between a JSON body and the measurement a goal
 * reports.
 */
describe("parseKeyResultInput", () => {
  it("supplies the target for a yes-no key result, which has none to ask for", () => {
    // The complaint this fixes: picking "boolean" still demanded two numbers.
    // `validateKeyResult` had always exempted boolean from the
    // start-must-differ-from-target rule, but nothing exempted it from needing
    // the number at all, so that exemption was unreachable through the form.
    const input = parseKeyResultInput({ title: "Shipped", metricKind: "boolean" });
    expect(input.targetValue).toBe(1);
    expect(input.startValue).toBeUndefined();
  });

  it("keeps a yes-no key result's start value, defaulting is left to the column", () => {
    // The start value is meaningful: a key result can describe something that
    // was already true when it was written.
    expect(
      parseKeyResultInput({ title: "Shipped", metricKind: "boolean", startValue: 1 })
        .startValue,
    ).toBe(1);
    expect(
      parseKeyResultInput({ title: "Shipped", metricKind: "boolean", startValue: 0 })
        .startValue,
    ).toBe(0);
  });

  it("refuses a non-truth value on a yes-no key result rather than coercing it", () => {
    // Reading 7 as "yes" is how a typo silently becomes a measurement.
    for (const field of ["startValue", "currentValue"]) {
      expect(() =>
        parseKeyResultInput({ title: "Shipped", metricKind: "boolean", [field]: 7 }),
      ).toThrow(new RegExp(`${field} must be 0 or 1`));
      expect(() =>
        parseKeyResultInput({ title: "Shipped", metricKind: "boolean", [field]: 7 }),
      ).toThrow(InvalidPatchError);
    }
  });

  it("still requires a target for every other metric kind", () => {
    expect(() => parseKeyResultInput({ title: "Actives" })).toThrow(
      /targetValue is required/,
    );
    expect(() =>
      parseKeyResultInput({ title: "Actives", metricKind: "percent" }),
    ).toThrow(/targetValue is required/);
  });

  it("defaults an unstated metric kind to number, NOT to the form's percent", () => {
    // The form now opens on Percentage, and the API deliberately does not
    // follow. Changing this default would silently reinterpret the payload of
    // every existing API and MCP client that omits the field, which is a
    // breaking change to fix a form default. This test exists so the two are
    // not "tidied up" into agreement later.
    const input = parseKeyResultInput({ title: "Actives", targetValue: 100 });
    expect(input.metricKind).toBeUndefined();

    // And the value the store falls back to is still number: a start of 0 and a
    // target of 0 is rejected, which only happens on the non-boolean path.
    expect(() =>
      parseKeyResultInput({ title: "Actives", targetValue: 0, startValue: 0 }),
    ).toThrow(/must differ/);
  });

  it("still rejects a degenerate span on a measured key result", () => {
    expect(() =>
      parseKeyResultInput({
        title: "Nowhere",
        metricKind: "percent",
        startValue: 5,
        targetValue: 5,
      }),
    ).toThrow(/must differ/);
  });
});
