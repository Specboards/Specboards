import { describe, expect, it } from "vitest";

import type { PropertyDef, WorkspaceLevel } from "@specboards/core";

import { planConversion, type ConversionInput } from "@/lib/convert-item";
import type { FeatureRecord, StageGate } from "@/lib/store/types";

/**
 * What a conversion says it will do, and what it refuses.
 *
 * The refusals are the feature. A conversion that quietly left a Work Item two
 * levels under an Epic, or detached a git-backed spec to make a promotion fit,
 * would be far more expensive to undo than a refusal is to work around. Each
 * case here is one of those, plus the effects that have to be stated before
 * somebody confirms rather than discovered afterwards.
 */

const LEVELS: WorkspaceLevel[] = [
  { key: "initiative", label: "Initiative", position: 0, isLeaf: false },
  { key: "epic", label: "Epic", position: 1, isLeaf: false },
  { key: "feature", label: "Feature", position: 2, isLeaf: false },
  { key: "work", label: "Work Item", position: 3, isLeaf: true },
];

const STATUSES = ["backlog", "defining", "ready", "in_progress", "done"];
const STATUS_LABELS = {
  backlog: "Backlog",
  defining: "Defining",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
};

function record(over: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    specId: "spec-1",
    title: "Checkout flow",
    level: "feature",
    isDbNative: true,
    productId: "prod-1",
    status: "backlog",
    rank: null,
    tags: [],
    releaseId: null,
    cycleId: null,
    assigneeId: null,
    customFields: {},
    path: "",
    blocksCount: 0,
    blockedByCount: 0,
    parentSpecId: null,
    childCount: 0,
    childDoneCount: 0,
    githubSummary: {
      openPrs: 0,
      mergedPrs: 0,
      issues: 0,
      branches: 0,
      total: 0,
    },
    ...over,
  } as FeatureRecord;
}

function plan(over: Partial<ConversionInput> = {}) {
  const rec = over.record ?? record();
  const input: ConversionInput = {
    item: {
      specId: rec.specId,
      title: rec.title,
      level: rec.level,
      status: rec.status,
      specPath: null,
      parentSpecId: rec.parentSpecId,
    },
    to: "epic",
    record: rec,
    parent: null,
    children: [],
    levels: LEVELS,
    properties: [],
    gates: [],
    completedGateIds: [],
    statuses: STATUSES,
    statusLabels: STATUS_LABELS,
    ...over,
  };
  return planConversion(input);
}

function property(over: Partial<PropertyDef> = {}): PropertyDef {
  return {
    id: "p1",
    key: "risk",
    label: "Risk",
    type: "text",
    entity: "item",
    options: [],
    levels: null,
    position: 0,
    ...over,
  };
}

function gate(over: Partial<StageGate> = {}): StageGate {
  return {
    id: "g1",
    stageKey: "backlog",
    kind: "field",
    fieldKey: "assignee",
    label: "Has an owner",
    position: 0,
    ...over,
  };
}

const kinds = (p: { blockers: { kind: string }[] }) =>
  p.blockers.map((b) => b.kind);
const effects = (p: { effects: { kind: string }[] }) =>
  p.effects.map((e) => e.kind);

describe("planConversion: what it refuses", () => {
  it("refuses a level the workspace does not have", () => {
    expect(kinds(plan({ to: "saga" }))).toEqual(["unknown-level"]);
  });

  it("refuses converting an item to what it already is", () => {
    expect(kinds(plan({ to: "feature" }))).toEqual(["same-level"]);
  });

  it("refuses to promote an item that holds a spec, and never detaches the file", () => {
    // Specs are leaf-only, and sync would reconcile a promoted row back down.
    // Removing a file from git as a side effect of a level change is not a
    // thing a level change gets to do.
    const p = plan({
      item: {
        specId: "spec-1",
        title: "Checkout flow",
        level: "work",
        status: "backlog",
        specPath: "specs/checkout/spec.md",
        parentSpecId: null,
      },
      record: record({ level: "work" }),
      to: "feature",
    });
    expect(kinds(p)).toEqual(["spec-attached"]);
    expect(p.blockers[0]!.message).toContain("specs/checkout/spec.md");
  });

  it("lets a spec-backed item convert when the target is still the leaf", () => {
    // There is only one leaf, so this is really "nothing to refuse when the
    // spec stays where specs live".
    const p = plan({
      item: {
        specId: "spec-1",
        title: "Checkout flow",
        level: "work",
        status: "backlog",
        specPath: "specs/checkout/spec.md",
        parentSpecId: null,
      },
      record: record({ level: "work" }),
      to: "work",
    });
    expect(kinds(p)).toEqual(["same-level"]);
  });

  it("refuses a promotion that would strand children, and names them", () => {
    // A Feature promoted to an Epic leaves its Work Items two levels below.
    const p = plan({
      to: "epic",
      children: [
        { specId: "c1", title: "Card payments", level: "work" },
        { specId: "c2", title: "Apple Pay", level: "work" },
      ],
    });
    expect(kinds(p)).toEqual(["children-stranded"]);
    const blocker = p.blockers[0] as { items: { title: string }[] };
    // Named and linkable, so the fix is one click away and the second attempt
    // succeeds. A refusal that does not say what is in the way is a dead end.
    expect(blocker.items.map((i) => i.title)).toEqual([
      "Card payments",
      "Apple Pay",
    ]);
  });

  it("gets the article right on a level whose label starts with a vowel", () => {
    // Levels are named by admins, so "a Epic" is a sentence the copy can
    // produce unless the article is computed.
    const p = plan({
      to: "epic",
      children: [{ specId: "c1", title: "Card payments", level: "work" }],
    });
    expect(p.blockers[0]!.message).toContain("an Epic holds Features");
  });

  it("allows a conversion whose children stay legal", () => {
    // Feature -> Epic with Feature children: they were one below a Feature and
    // are one below an Epic too.
    const p = plan({
      to: "epic",
      children: [{ specId: "c1", title: "Payments", level: "feature" }],
    });
    expect(p.blockers).toEqual([]);
    expect(effects(p)).toContain("children-kept");
  });

  it("refuses when a stage ahead requires a field the target level cannot set", () => {
    // The item would land in a status it could never advance out of, with no
    // control on screen to fix it.
    const p = plan({
      to: "epic",
      levels: LEVELS.map((l) =>
        l.key === "epic" ? { ...l, fields: ["tags"] } : l,
      ),
      gates: [gate({ stageKey: "ready", fieldKey: "assignee" })],
    });
    expect(kinds(p)).toEqual(["gates-unsatisfiable"]);
    const blocker = p.blockers[0] as { gates: string[] };
    expect(blocker.gates[0]).toContain("Ready");
  });

  it("ignores a gate the item has already satisfied", () => {
    // A field gate reads the item's own data, and a value that is set stays set
    // even once the field is hidden.
    const p = plan({
      to: "epic",
      record: record({ assigneeId: "u-1" }),
      levels: LEVELS.map((l) =>
        l.key === "epic" ? { ...l, fields: ["tags"] } : l,
      ),
      gates: [gate({ stageKey: "ready", fieldKey: "assignee" })],
    });
    expect(p.blockers).toEqual([]);
  });

  it("ignores a gate on a stage the item is already past", () => {
    const p = plan({
      to: "epic",
      record: record({ status: "ready" }),
      levels: LEVELS.map((l) =>
        l.key === "epic" ? { ...l, fields: ["tags"] } : l,
      ),
      gates: [gate({ stageKey: "backlog", fieldKey: "assignee" })],
    });
    expect(p.blockers).toEqual([]);
  });

  it("refuses a parent gate on a promotion to the top level", () => {
    // Unsatisfiable by construction rather than by configuration: a top-level
    // item cannot have a parent at all.
    const p = plan({
      record: record({ level: "epic" }),
      item: {
        specId: "spec-1",
        title: "Checkout flow",
        level: "epic",
        status: "backlog",
        specPath: null,
        parentSpecId: null,
      },
      to: "initiative",
      gates: [gate({ stageKey: "defining", fieldKey: "parent" })],
    });
    expect(kinds(p)).toEqual(["gates-unsatisfiable"]);
  });

  it("leaves a checklist gate alone, since a box can be ticked at any level", () => {
    const p = plan({
      to: "epic",
      gates: [gate({ kind: "checklist", fieldKey: null, stageKey: "ready" })],
    });
    expect(p.blockers).toEqual([]);
  });
});

describe("planConversion: what it says it will do", () => {
  it("says the parent will be dropped, rather than dropping it quietly", () => {
    const p = plan({
      to: "epic",
      parent: { specId: "p1", title: "Payments", level: "epic" },
    });
    expect(p.detachesParent).toBe(true);
    expect(effects(p)).toContain("parent-detached");
    expect(p.effects[0]!.message).toContain("Payments");
  });

  it("keeps a parent that is still one level up after the conversion", () => {
    // Feature -> Epic under an Initiative: an Epic belongs under an Initiative.
    const p = plan({
      to: "epic",
      parent: { specId: "p1", title: "Growth", level: "initiative" },
    });
    expect(p.detachesParent).toBe(false);
    expect(effects(p)).toContain("parent-kept");
  });

  it("promises a property's value is kept rather than dropped", () => {
    // The one place where doing nothing is better than either alternative:
    // dropping the value loses data, and carrying it forward invents a field.
    const p = plan({
      to: "epic",
      properties: [property({ levels: ["feature"] })],
      record: record({ customFields: { risk: "high" } }),
    });
    const effect = p.effects.find((e) => e.kind === "properties-hidden");
    expect(effect?.message).toContain("Risk");
    expect(effect?.message).toContain("kept");
  });

  it("says nothing about a property that has no value to keep", () => {
    // An empty property disappearing is not news, and a preview that lists
    // every configuration difference stops being read.
    const p = plan({
      to: "epic",
      properties: [property({ levels: ["feature"] })],
    });
    expect(effects(p)).not.toContain("properties-hidden");
  });

  it("names the properties and fields that become available", () => {
    const p = plan({
      to: "epic",
      properties: [
        property({ key: "bet", label: "Bet size", levels: ["epic"] }),
      ],
      levels: LEVELS.map((l) =>
        l.key === "feature" ? { ...l, fields: ["tags"] } : l,
      ),
    });
    expect(effects(p)).toContain("properties-shown");
    expect(effects(p)).toContain("fields-gained");
  });

  it("warns that a target level's template will not overwrite the body", () => {
    const p = plan({
      to: "epic",
      levels: LEVELS.map((l) =>
        l.key === "epic" ? { ...l, detailTemplateId: "t1" } : l,
      ),
    });
    const effect = p.effects.find((e) => e.kind === "template-mismatch");
    expect(effect?.message).toContain("keeps the body it already has");
  });

  it("reports a clean conversion with no blockers and no surprises", () => {
    const p = plan({ to: "epic" });
    expect(p.blockers).toEqual([]);
    expect(p.effects).toEqual([]);
    expect(p.fromLabel).toBe("Feature");
    expect(p.toLabel).toBe("Epic");
  });
});
