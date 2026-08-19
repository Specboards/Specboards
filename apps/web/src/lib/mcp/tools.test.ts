import { describe, expect, it } from "vitest";

import { SCOPE_RESOURCES } from "@/lib/api-scopes";

import { TOOLS } from "./tools";

/**
 * Registry invariants for the MCP surface. Nothing here calls a tool; it
 * guards the contract every client sees through tools/list, and the two
 * properties that have security consequences: `write` is what the RPC layer
 * checks before letting a caller mutate, and `scope` is what it checks against
 * a restricted API key. A mutating tool that forgets either is a hole, not a
 * typo.
 */

/** Verbs that mutate. Everything else must be a read. */
const MUTATING = /^(create|update|delete|link|unlink|rollover)_/;

describe("the tool registry", () => {
  it("has no duplicate names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares a known scope resource for every tool", () => {
    // `/api/mcp` is one URL, so a tool's scope cannot be derived from the path
    // the way the REST routes' are. If this list and SCOPE_RESOURCES drift
    // apart, keys can be granted a scope no tool honours, or vice versa.
    for (const t of TOOLS) {
      expect(SCOPE_RESOURCES, t.name).toContain(t.scope.resource);
    }
  });

  it("requires a write scope for exactly the write tools", () => {
    for (const t of TOOLS) {
      expect({ name: t.name, action: t.scope.action }).toEqual({
        name: t.name,
        action: t.write ? "write" : "read",
      });
    }
  });

  it("marks every mutating tool as a write, and no others", () => {
    for (const t of TOOLS) {
      expect({ name: t.name, write: t.write }).toEqual({
        name: t.name,
        write: MUTATING.test(t.name),
      });
    }
  });

  it("maps every tool to the scope its REST equivalent derives from its URL", () => {
    // Spelled out rather than computed: this table is the authorization model
    // for key-authenticated agents, so a change to it should be a visible diff
    // someone signs off on. It mirrors what `requiredScopeFor` would return for
    // the equivalent REST route, so one key behaves the same over both
    // surfaces - hence `create_spec` is `specs:write` (POST /api/v1/specs) while
    // `update_spec_content` is `features:write`
    // (PUT /api/v1/features/<id>/content).
    const expected: Record<string, string> = {
      whoami: "me:read",
      list_statuses: "statuses:read",
      list_products: "products:read",
      list_product_groups: "product-groups:read",
      group_summary: "product-groups:read",
      list_items: "features:read",
      read_item: "features:read",
      get_relations: "features:read",
      list_github_links: "features:read",
      update_item: "features:write",
      delete_item: "features:write",
      create_item: "features:write",
      update_spec_content: "features:write",
      link_github: "features:write",
      unlink_github: "features:write",
      create_spec: "specs:write",
      list_releases: "releases:read",
      create_release: "releases:write",
      update_release: "releases:write",
      update_release_notes: "releases:write",
      list_cycles: "cycles:read",
      create_cycle: "cycles:write",
      update_cycle: "cycles:write",
      rollover_cycle: "cycles:write",
      list_goals: "goals:read",
      read_goal: "goals:read",
      create_goal: "goals:write",
      update_goal: "goals:write",
      delete_goal: "goals:write",
      link_goal: "goals:write",
      create_key_result: "key-results:write",
      update_key_result: "key-results:write",
      delete_key_result: "key-results:write",
      list_docs: "docs:read",
      read_doc: "docs:read",
      create_doc: "docs:write",
      update_doc: "docs:write",
      delete_doc: "docs:write",
    };
    const actual = Object.fromEntries(
      TOOLS.map((t) => [t.name, `${t.scope.resource}:${t.scope.action}`]),
    );
    // Equality both ways: a new tool with no entry here fails just as loudly as
    // a changed mapping, so the table cannot quietly fall behind the registry.
    expect(actual).toEqual(expected);
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

/**
 * That the real tools actually validate a spec id, rather than leaving it to
 * Postgres.
 *
 * The disclosure bug this guards was found by calling `read_item` with an
 * 8-character prefix: `features.spec_id` is a `uuid` column, so the driver
 * rejected it and its error carried the whole statement back to the caller.
 * `error-disclosure.test.ts` covers both halves of the fix in isolation - that
 * `requireUuid` rejects a prefix, and that the boundary withholds a driver
 * error. Neither proves the tools are *wired* to `requireUuid`, which is the
 * part a later refactor could quietly undo.
 *
 * These run the genuine registry, so nothing is mocked. Validation is the first
 * thing each `run` does, which is why no store or database is needed: reaching
 * one would itself be the failure.
 */
describe("spec id validation is wired into the tools", () => {
  /** Enough of an McpContext to call `run`; never read, as validation throws first. */
  const ctx = {
    scope: { userId: "user-1", workspaceId: "ws-1" },
    role: "owner",
    isLocal: false,
    scopes: [],
    credentialKey: null,
    allowDestructive: true,
  } as unknown as Parameters<(typeof TOOLS)[number]["run"]>[1];

  const specIdOnly = TOOLS.filter((t) => {
    const schema = t.inputSchema as { required?: unknown };
    const required = schema.required;
    return (
      Array.isArray(required) &&
      required.length === 1 &&
      required[0] === "specId"
    );
  });

  it("finds tools to check", () => {
    // Guards against the filter silently matching nothing after a refactor,
    // which would make every case below pass without asserting anything.
    expect(specIdOnly.length).toBeGreaterThanOrEqual(4);
    expect(specIdOnly.map((t) => t.name)).toContain("read_item");
  });

  it.each(specIdOnly.map((t) => [t.name, t] as const))(
    "%s rejects an abbreviated spec id before any query",
    async (_name, tool) => {
      await expect(tool.run({ specId: "7f053ebc" }, ctx)).rejects.toThrow(
        /must be a full UUID/,
      );
    },
  );
});
