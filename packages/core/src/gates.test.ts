import { describe, expect, it } from "vitest";

import {
  BUILTIN_GATE_FIELDS,
  fieldGateSatisfied,
  gateFieldCatalog,
  gateFieldLabel,
  type GateSubject,
} from "./gates.js";

const PROPERTIES = [
  { key: "target_end_date", label: "Target End Date", entity: "item" },
  { key: "risk", label: "Risk", entity: "item" },
  { key: "launch_owner", label: "Launch owner", entity: "release" },
];

const CATALOG = gateFieldCatalog(PROPERTIES);

function item(overrides: Partial<GateSubject> = {}): GateSubject {
  return {
    assigneeId: null,
    releaseId: null,
    cycleId: null,
    parentId: null,
    tags: [],
    customFields: {},
    ...overrides,
  };
}

describe("gateFieldCatalog", () => {
  it("offers the built-ins plus this workspace's item properties", () => {
    expect(CATALOG.map((f) => f.key)).toEqual([
      ...BUILTIN_GATE_FIELDS.map((f) => f.key),
      "cf:target_end_date",
      "cf:risk",
    ]);
  });

  it("leaves release properties out: a gate guards an item's stage", () => {
    expect(CATALOG.some((f) => f.key === "cf:launch_owner")).toBe(false);
  });
});

describe("fieldGateSatisfied, built-in fields", () => {
  it("is met once the field holds something", () => {
    expect(fieldGateSatisfied("assignee", item(), CATALOG)).toBe(false);
    expect(
      fieldGateSatisfied("assignee", item({ assigneeId: "u1" }), CATALOG),
    ).toBe(true);
    expect(
      fieldGateSatisfied("release", item({ releaseId: "r1" }), CATALOG),
    ).toBe(true);
    expect(fieldGateSatisfied("cycle", item({ cycleId: "c1" }), CATALOG)).toBe(
      true,
    );
    expect(fieldGateSatisfied("parent", item({ parentId: "p1" }), CATALOG)).toBe(
      true,
    );
  });

  it("treats an empty tag list as unset", () => {
    expect(fieldGateSatisfied("tags", item({ tags: [] }), CATALOG)).toBe(false);
    expect(fieldGateSatisfied("tags", item({ tags: ["area:ux"] }), CATALOG)).toBe(
      true,
    );
  });
});

describe("fieldGateSatisfied, custom properties", () => {
  const withField = (value: unknown) =>
    item({ customFields: { target_end_date: value } });

  it("is met by a value and not by a blank one", () => {
    expect(fieldGateSatisfied("cf:target_end_date", item(), CATALOG)).toBe(false);
    expect(
      fieldGateSatisfied("cf:target_end_date", withField(null), CATALOG),
    ).toBe(false);
    expect(fieldGateSatisfied("cf:target_end_date", withField(""), CATALOG)).toBe(
      false,
    );
    expect(
      fieldGateSatisfied("cf:target_end_date", withField("   "), CATALOG),
    ).toBe(false);
    expect(
      fieldGateSatisfied("cf:target_end_date", withField("2026-10-01"), CATALOG),
    ).toBe(true);
  });

  it("counts zero and false as answers, because somebody set them", () => {
    // A required checkbox has to be satisfiable with a No, and 0 is a number
    // the person typed. The alternative makes those two values impossible to
    // supply, which is not what "must be populated" means anywhere else.
    expect(fieldGateSatisfied("cf:risk", item({ customFields: { risk: 0 } }), CATALOG)).toBe(
      true,
    );
    expect(
      fieldGateSatisfied("cf:risk", item({ customFields: { risk: false } }), CATALOG),
    ).toBe(true);
  });

  it("treats an empty multi-select as unset", () => {
    expect(
      fieldGateSatisfied("cf:risk", item({ customFields: { risk: [] } }), CATALOG),
    ).toBe(false);
    expect(
      fieldGateSatisfied("cf:risk", item({ customFields: { risk: ["high"] } }), CATALOG),
    ).toBe(true);
  });
});

describe("a gate whose field no longer exists", () => {
  it("is never satisfied, so deleting a property cannot silently unblock a stage", () => {
    const gone = item({ customFields: { deleted_property: "still here" } });
    expect(fieldGateSatisfied("cf:deleted_property", gone, CATALOG)).toBe(false);
  });

  it("says so in its label, using the name the gate was created with", () => {
    expect(
      gateFieldLabel("cf:deleted_property", CATALOG, "Target End Date"),
    ).toBe("Target End Date (no longer exists)");
    // With no snapshot to fall back on, the bare key beats an empty string.
    expect(gateFieldLabel("cf:deleted_property", CATALOG)).toBe(
      "deleted_property (no longer exists)",
    );
  });
});

describe("gateFieldLabel", () => {
  it("reads the current name from the catalog, not the gate's snapshot", () => {
    // The property was renamed after the gate was created; the gate follows.
    expect(gateFieldLabel("cf:target_end_date", CATALOG, "Old Name")).toBe(
      "Target End Date",
    );
    expect(gateFieldLabel("assignee", CATALOG)).toBe("Assignee");
  });
});
