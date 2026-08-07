import { describe, expect, it } from "vitest";

import { TOOLS } from "./tools";

/**
 * Registry invariants for the MCP surface. Nothing here calls a tool; it
 * guards the contract every client sees through tools/list, and the one
 * property that has security consequences: `write` is what the RPC layer
 * checks before letting a caller mutate, so a mutating tool that forgets the
 * flag is a hole, not a typo.
 */

/** Verbs that mutate. Everything else must be a read. */
const MUTATING = /^(create|update|delete|link|unlink|rollover)_/;

describe("the tool registry", () => {
  it("has no duplicate names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks every mutating tool as a write, and no others", () => {
    for (const t of TOOLS) {
      expect({ name: t.name, write: t.write }).toEqual({
        name: t.name,
        write: MUTATING.test(t.name),
      });
    }
  });

  it("advertises a closed object schema for every tool", () => {
    for (const t of TOOLS) {
      const schema = t.inputSchema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(schema.type, t.name).toBe("object");
      // Closed schemas keep a client from silently passing an argument the
      // tool ignores (a typo'd field would otherwise look like it applied).
      expect(schema.additionalProperties, t.name).toBe(false);
      for (const key of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {}), t.name).toContain(key);
      }
    }
  });

  it("describes every tool for the model that has to choose one", () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });

  it("covers the Plan doc areas: strategy, research, architecture", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_docs",
        "read_doc",
        "create_doc",
        "update_doc",
        "delete_doc",
      ]),
    );
    // All five are addressed the same way: a product key plus an area.
    for (const name of ["list_docs", "read_doc", "create_doc", "update_doc", "delete_doc"]) {
      const schema = TOOLS.find((t) => t.name === name)!.inputSchema as {
        required: string[];
        properties: { area: { enum: string[] } };
      };
      expect(schema.required, name).toEqual(
        expect.arrayContaining(["product", "area"]),
      );
      expect(schema.properties.area.enum, name).toEqual([
        "strategy",
        "research",
        "architecture",
      ]);
    }
  });

  it("covers goals end to end, including the deletes", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_goals",
        "read_goal",
        "create_goal",
        "update_goal",
        "delete_goal",
        "create_key_result",
        "update_key_result",
        "delete_key_result",
        "link_goal",
      ]),
    );
  });
});
