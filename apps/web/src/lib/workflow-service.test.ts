import { describe, expect, it } from "vitest";

import { parseStageGates } from "@/lib/workflow-service";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * The boundary between an untrusted request body and the stage-gate rows that
 * decide whether work can advance. Getting `kind` wrong here is how a field
 * requirement would quietly become an always-satisfied checklist item.
 */
describe("parseStageGates", () => {
  it("defaults kind to checklist, so a client written before field gates still works", () => {
    expect(
      parseStageGates({ gates: [{ stageKey: "ready", label: "Spec reviewed" }] }),
    ).toEqual([
      { stageKey: "ready", kind: "checklist", fieldKey: null, label: "Spec reviewed" },
    ]);
  });

  it("keeps an existing gate's id, which is what preserves its completions", () => {
    const [gate] = parseStageGates({
      gates: [{ id: "abc", stageKey: "ready", label: "Spec reviewed" }],
    });
    expect(gate?.id).toBe("abc");
  });

  it("accepts a field gate and carries its fieldKey", () => {
    expect(
      parseStageGates({
        gates: [
          {
            stageKey: "ready",
            kind: "field",
            fieldKey: "cf:target_end_date",
            label: "Target End Date",
          },
        ],
      }),
    ).toEqual([
      {
        stageKey: "ready",
        kind: "field",
        fieldKey: "cf:target_end_date",
        label: "Target End Date",
      },
    ]);
  });

  it("drops a fieldKey sent on a checklist gate rather than storing a contradiction", () => {
    // The database CHECK refuses this pairing; normalizing here means a
    // confused client gets a saved gate rather than a 500 from Postgres.
    const [gate] = parseStageGates({
      gates: [
        { stageKey: "ready", kind: "checklist", fieldKey: "assignee", label: "Done" },
      ],
    });
    expect(gate?.fieldKey).toBeNull();
  });

  it("refuses a field gate with no field", () => {
    expect(() =>
      parseStageGates({
        gates: [{ stageKey: "ready", kind: "field", label: "Something" }],
      }),
    ).toThrow(InvalidPatchError);
    expect(() =>
      parseStageGates({
        gates: [
          { stageKey: "ready", kind: "field", fieldKey: "   ", label: "Something" },
        ],
      }),
    ).toThrow(InvalidPatchError);
  });

  it("refuses a kind it does not know", () => {
    expect(() =>
      parseStageGates({
        gates: [{ stageKey: "ready", kind: "automatic", label: "Something" }],
      }),
    ).toThrow(InvalidPatchError);
  });

  it("still requires a stage and a label of every gate", () => {
    expect(() => parseStageGates({ gates: [{ label: "Orphan" }] })).toThrow(
      InvalidPatchError,
    );
    expect(() => parseStageGates({ gates: [{ stageKey: "ready" }] })).toThrow(
      InvalidPatchError,
    );
  });

  it("accepts an empty list: that is how a product goes back to inheriting", () => {
    expect(parseStageGates({ gates: [] })).toEqual([]);
  });

  it("rejects a body that is not the shape it claims", () => {
    expect(() => parseStageGates({ gates: "ready" })).toThrow(InvalidPatchError);
    expect(() => parseStageGates([])).toThrow(InvalidPatchError);
    expect(() => parseStageGates(null)).toThrow(InvalidPatchError);
  });
});
