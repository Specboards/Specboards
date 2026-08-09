import { describe, expect, it } from "vitest";

import {
  InvalidScopeError,
  isScopeExemptPath,
  keyScopesSatisfy,
  parseApiScopes,
  requiredScopeFor,
  SCOPE_RESOURCES,
} from "./api-scopes";

describe("parseApiScopes", () => {
  it("accepts an empty/omitted list (full-access key)", () => {
    expect(parseApiScopes(undefined)).toEqual([]);
    expect(parseApiScopes(null)).toEqual([]);
    expect(parseApiScopes([])).toEqual([]);
  });

  it("accepts valid resource:action tokens and the wildcard", () => {
    expect(parseApiScopes(["features:write", "statuses:read"])).toEqual([
      "features:write",
      "statuses:read",
    ]);
    expect(parseApiScopes(["*"])).toEqual(["*"]);
  });

  it("de-duplicates and sorts", () => {
    expect(parseApiScopes(["statuses:read", "features:write", "features:write"])).toEqual([
      "features:write",
      "statuses:read",
    ]);
  });

  it("rejects malformed tokens", () => {
    expect(() => parseApiScopes(["features"])).toThrow(InvalidScopeError);
    expect(() => parseApiScopes(["features:delete"])).toThrow(InvalidScopeError);
    expect(() => parseApiScopes(["Features:read"])).toThrow(InvalidScopeError);
    expect(() => parseApiScopes("features:read")).toThrow(InvalidScopeError);
    expect(() => parseApiScopes([42])).toThrow(InvalidScopeError);
  });
});

describe("requiredScopeFor", () => {
  it("maps read methods to <resource>:read", () => {
    expect(requiredScopeFor("GET", "/api/v1/features")).toEqual({
      resource: "features",
      action: "read",
    });
    expect(requiredScopeFor("GET", "/api/v1/statuses")).toEqual({
      resource: "statuses",
      action: "read",
    });
  });

  it("maps mutating methods to <resource>:write", () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(requiredScopeFor(method, "/api/v1/features/abc")).toEqual({
        resource: "features",
        action: "write",
      });
    }
  });

  it("uses the first path segment as the resource", () => {
    expect(requiredScopeFor("POST", "/api/v1/features/abc/github-links")).toEqual({
      resource: "features",
      action: "write",
    });
  });

  it("returns null for non-/api/v1 and session-only api-keys paths", () => {
    expect(requiredScopeFor("GET", "/dashboard")).toBeNull();
    expect(requiredScopeFor("POST", "/api/v1/api-keys")).toBeNull();
  });
});

describe("keyScopesSatisfy", () => {
  const read = { resource: "features", action: "read" } as const;
  const write = { resource: "features", action: "write" } as const;

  it("treats an empty grant list as full access (legacy keys)", () => {
    expect(keyScopesSatisfy([], read)).toBe(true);
    expect(keyScopesSatisfy([], write)).toBe(true);
  });

  it("honors the wildcard", () => {
    expect(keyScopesSatisfy(["*"], write)).toBe(true);
  });

  it("write grant satisfies both read and write", () => {
    expect(keyScopesSatisfy(["features:write"], read)).toBe(true);
    expect(keyScopesSatisfy(["features:write"], write)).toBe(true);
  });

  it("read grant satisfies only read", () => {
    expect(keyScopesSatisfy(["features:read"], read)).toBe(true);
    expect(keyScopesSatisfy(["features:read"], write)).toBe(false);
  });

  it("a grant on another resource does not leak", () => {
    expect(keyScopesSatisfy(["releases:write"], write)).toBe(false);
    expect(keyScopesSatisfy(["releases:write"], read)).toBe(false);
  });
});

describe("isScopeExemptPath", () => {
  it("exempts only the surfaces that scope themselves", () => {
    // `/api/mcp` carries the resource in the JSON-RPC tool name, so it is
    // checked per tool in lib/mcp/rpc.ts rather than per path.
    expect(isScopeExemptPath("/api/mcp")).toBe(true);
    expect(isScopeExemptPath("/api/mcp/workspace-binding")).toBe(true);
    expect(isScopeExemptPath("/api/v1/openapi.json")).toBe(true);
  });

  it("does not exempt anything else, including near-misses", () => {
    expect(isScopeExemptPath("/api/mcp-admin")).toBe(false);
    expect(isScopeExemptPath("/api/v1/features")).toBe(false);
    expect(isScopeExemptPath("/api/webhooks/github")).toBe(false);
    expect(isScopeExemptPath("/dashboard")).toBe(false);
  });
});

describe("the resource vocabulary", () => {
  it("covers every /api/v1 route a key can reach", async () => {
    // A resource route with no SCOPE_RESOURCES entry can never be granted to a
    // key: `requiredScopeFor` still derives `<segment>:<action>` and no grant
    // satisfies it, so the endpoint is silently unreachable for scoped keys.
    // Walk the real route tree so a new resource cannot land without an entry.
    const { readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../app/api/v1", import.meta.url));
    const entries = await readdir(dir, { withFileTypes: true });

    // Routes that are deliberately unreachable with an API key. Each one is
    // session-only and gates itself; `requiredScopeFor` returning a scope
    // nobody can hold is the point, not an oversight.
    const SESSION_ONLY = new Set([
      "api-keys", // a key must not mint or revoke keys
      "github", // OAuth / App install flows, driven by a browser redirect
      "workspaces", // first-run org creation from /setup
    ]);

    const missing = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !SESSION_ONLY.has(name))
      // Exempt paths (e.g. openapi.json) need no scope by design.
      .filter((name) => !isScopeExemptPath(`/api/v1/${name}`))
      .filter((name) => !(SCOPE_RESOURCES as readonly string[]).includes(name));

    expect(missing).toEqual([]);
  });
});
