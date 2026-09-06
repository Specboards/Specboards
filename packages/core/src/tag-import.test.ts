import { describe, expect, it } from "vitest";

import type { TagDef } from "./tags.js";
import {
  TAG_IMPORT_MAX_ROWS,
  TAG_IMPORT_TEMPLATE,
  looksLikeHeader,
  parseCsvRows,
  planTagImport,
  type TagImportAction,
} from "./tag-import.js";

function tag(name: string, position = 0): TagDef {
  return { id: `id-${name}`, name, position };
}

/** The plan, flattened to something a test can read at a glance. */
function summarise(actions: TagImportAction[]): string[] {
  return actions.map((a) => {
    switch (a.kind) {
      case "create":
        return `create ${a.name}`;
      case "rename":
        return `rename ${a.from} -> ${a.to}`;
      case "merge":
        return `merge ${a.from} -> ${a.to}`;
      case "unchanged":
        return `unchanged ${a.name}`;
      case "error":
        return `error ${a.error}`;
    }
  });
}

describe("parseCsvRows", () => {
  it("splits fields and rows", () => {
    expect(parseCsvRows("a,b\nc,d")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
    ]);
  });

  it("drops blank lines rather than reporting them", () => {
    // A trailing newline is how every editor ends a file, and Excel adds more.
    expect(parseCsvRows("a\n\n\nb\n")).toEqual([
      { line: 1, cells: ["a"] },
      { line: 4, cells: ["b"] },
    ]);
  });

  it("handles CRLF, which is what Excel on Windows writes", () => {
    expect(parseCsvRows("a,b\r\nc,d\r\n")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["c", "d"] },
    ]);
  });

  it("strips the BOM Excel puts in front of the first field", () => {
    expect(parseCsvRows("﻿tag\nSF")).toEqual([
      { line: 1, cells: ["tag"] },
      { line: 2, cells: ["SF"] },
    ]);
  });

  it("reads quoted fields, including escaped quotes", () => {
    expect(parseCsvRows('"a ""b""",c')).toEqual([
      { line: 1, cells: ['a "b"', "c"] },
    ]);
  });

  it("keeps a quoted empty field, which the author wrote deliberately", () => {
    expect(parseCsvRows('"",x')).toEqual([{ line: 1, cells: ["", "x"] }]);
  });
});

describe("looksLikeHeader", () => {
  it("recognises the headings a person actually writes", () => {
    expect(looksLikeHeader(["Existing tag", "New name"])).toBe(true);
    expect(looksLikeHeader(["tag"])).toBe(true);
  });

  it("leaves data alone", () => {
    expect(looksLikeHeader(["SF", "Salesforce"])).toBe(false);
    expect(looksLikeHeader(["area:web"])).toBe(false);
  });

  it("does not treat a half-heading row as headings", () => {
    // "tag" is a heading word and "Salesforce" is not, so this is data.
    expect(looksLikeHeader(["tag", "Salesforce"])).toBe(false);
  });

  it("keeps a one-column row whose word could be a tag", () => {
    // A list of tags starting with "new" is a list of tags. Only words that
    // describe the column rather than name a thing count on their own.
    expect(looksLikeHeader(["new"])).toBe(false);
    expect(looksLikeHeader(["to"])).toBe(false);
    expect(looksLikeHeader(["new", "old"])).toBe(true);
  });
});

describe("planTagImport", () => {
  const registry = [tag("area:web", 0), tag("SF", 1)];

  it("adds the tags a one-column file lists", () => {
    const plan = planTagImport("alpha\nbeta\n", []);
    expect(summarise(plan.actions)).toEqual(["create alpha", "create beta"]);
    expect(plan.writes).toBe(2);
  });

  it("skips a header row", () => {
    const plan = planTagImport("tag\nalpha\n", []);
    expect(summarise(plan.actions)).toEqual(["create alpha"]);
  });

  it("renames an existing tag, which is what the second column is for", () => {
    const plan = planTagImport("SF,Salesforce\n", registry);
    expect(summarise(plan.actions)).toEqual(["rename SF -> Salesforce"]);
  });

  it("merges when the new name is a tag that already exists", () => {
    // The single-tag rename refuses this on purpose. A mapping file is asking
    // for it, so here it is a merge and the preview says so.
    const plan = planTagImport("SF,area:web\n", registry);
    expect(summarise(plan.actions)).toEqual(["merge SF -> area:web"]);
  });

  it("merges onto the registry's spelling, not the file's", () => {
    const plan = planTagImport("SF,AREA:WEB\n", registry);
    expect(summarise(plan.actions)).toEqual(["merge SF -> area:web"]);
  });

  it("treats a trailing comma as a one-column row, not a rename to nothing", () => {
    // This is what a two-column spreadsheet exports for a row that only adds.
    const plan = planTagImport("alpha,\n", []);
    expect(summarise(plan.actions)).toEqual(["create alpha"]);
  });

  it("reports a tag that does not exist rather than inventing one", () => {
    const plan = planTagImport("nope,Something\n", registry);
    expect(plan.actions[0]).toMatchObject({ kind: "error" });
    expect(summarise(plan.actions)[0]).toContain('No tag named "nope"');
  });

  it("carries a rename onto the rows below it", () => {
    // Line 2 has to see what line 1 did, or consolidating spellings in one file
    // silently does the wrong thing.
    const plan = planTagImport("SF,Salesforce\narea:web,Salesforce\n", registry);
    expect(summarise(plan.actions)).toEqual([
      "rename SF -> Salesforce",
      "merge area:web -> Salesforce",
    ]);
  });

  it("merges into a tag the same file created a moment earlier", () => {
    const plan = planTagImport("Salesforce\nSF,Salesforce\n", registry);
    expect(summarise(plan.actions)).toEqual([
      "create Salesforce",
      "merge SF -> Salesforce",
    ]);
  });

  it("refuses to rename the same tag twice", () => {
    const plan = planTagImport("SF,Salesforce\nSalesforce,CRM\n", registry);
    expect(summarise(plan.actions)[1]).toContain("already renamed");
  });

  it("calls a duplicate add unchanged rather than an error", () => {
    const plan = planTagImport("area:web\nAREA:WEB\n", registry);
    expect(summarise(plan.actions)).toEqual([
      "unchanged area:web",
      "unchanged area:web",
    ]);
    expect(plan.writes).toBe(0);
  });

  it("treats a change of case as a rename, since it changes the spelling", () => {
    const plan = planTagImport("SF,sf\n", registry);
    expect(summarise(plan.actions)).toEqual(["rename SF -> sf"]);
  });

  it("calls an exact match unchanged", () => {
    const plan = planTagImport("SF,SF\n", registry);
    expect(summarise(plan.actions)).toEqual(["unchanged SF"]);
  });

  it("rejects a name the registry could never store", () => {
    const plan = planTagImport("SF,a,b\n", registry);
    // The third column is ignored, so this is SF -> "a", which is fine.
    expect(summarise(plan.actions)).toEqual(["rename SF -> a"]);
    expect(summarise(planTagImport('SF,"a,b"\n', registry).actions)[0]).toContain(
      "commas",
    );
  });

  it("reports a missing left-hand side instead of guessing", () => {
    expect(summarise(planTagImport(",Salesforce\n", registry).actions)[0]).toContain(
      "Missing the tag to rename",
    );
  });

  it("counts what it would do", () => {
    const plan = planTagImport("new\nSF,Salesforce\narea:web\nnope,x\n", registry);
    expect(plan.counts).toEqual({
      create: 1,
      rename: 1,
      merge: 0,
      unchanged: 1,
      error: 1,
    });
    expect(plan.writes).toBe(2);
  });

  it("stops after the row cap instead of accepting an unbounded file", () => {
    const csv = Array.from({ length: TAG_IMPORT_MAX_ROWS + 5 }, (_, i) => `t${i}`)
      .join("\n");
    const plan = planTagImport(csv, []);
    expect(plan.counts.create).toBe(TAG_IMPORT_MAX_ROWS);
    expect(plan.counts.error).toBe(1);
  });

  it("plans the template it hands out", () => {
    const plan = planTagImport(TAG_IMPORT_TEMPLATE, [tag("SF")]);
    expect(summarise(plan.actions)).toEqual([
      "rename SF -> Salesforce",
      "create area:web",
      "create area:api",
    ]);
  });
});
