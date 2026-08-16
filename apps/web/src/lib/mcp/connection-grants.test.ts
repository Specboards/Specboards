import { describe, expect, it } from "vitest";

import { parseApiScopes } from "@/lib/api-scopes";

import {
  CONNECTION_GRANTS,
  DEFAULT_CONNECTION_GRANT,
  connectionGrantById,
  describeStoredGrant,
} from "./connection-grants";
import { TOOLS } from "./tools";
import { toolAllowedByScope } from "./rpc";
import type { McpContext } from "./types";

/**
 * The grants the OAuth consent screen offers, checked against the tool surface
 * they actually govern. The point of this feature is that a connection can be
 * given less than its user has, so what matters is that each grant really does
 * stop the tools it claims to.
 */

function ctxFor(id: string): McpContext {
  const grant = connectionGrantById(id);
  return {
    scope: { userId: "u", workspaceId: "w" },
    role: "member",
    isLocal: false,
    scopes: grant.scopes,
    allowDestructive: grant.allowDestructive,
  };
}

const allowed = (id: string, tool: string) =>
  toolAllowedByScope(
    TOOLS.find((t) => t.name === tool)!,
    ctxFor(id),
  );

describe("grant definitions", () => {
  it("produce scopes the API validator accepts", () => {
    for (const grant of CONNECTION_GRANTS) {
      expect(parseApiScopes(grant.scopes), grant.id).toEqual(grant.scopes);
    }
  });

  it("defaults to something narrower than full access", () => {
    const fallback = connectionGrantById(undefined);
    expect(fallback.id).toBe(DEFAULT_CONNECTION_GRANT);
    expect(fallback.id).not.toBe("full");
    expect(fallback.allowDestructive).toBe(false);
  });

  it("falls back to the default for an unknown or forged id", () => {
    // The consent route resolves an id rather than accepting a scope list, so
    // a crafted body lands here. It must never widen past the default.
    for (const forged of ["full-access", "", null, 42, { id: "full" }]) {
      expect(connectionGrantById(forged).id, String(forged)).toBe(
        DEFAULT_CONNECTION_GRANT,
      );
    }
  });
});

describe("read-only", () => {
  it("reads anything and writes nothing", () => {
    expect(allowed("read", "list_items")).toBe(true);
    expect(allowed("read", "read_item")).toBe(true);
    expect(allowed("read", "list_goals")).toBe(true);
    for (const tool of ["create_item", "update_item", "create_spec", "create_release"]) {
      expect(allowed("read", tool), tool).toBe(false);
    }
  });
});

describe("read-and-author (the default)", () => {
  it("authors work and specs", () => {
    for (const tool of [
      "create_item",
      "update_item",
      "create_spec",
      "update_spec_content",
      "create_release",
      "create_goal",
    ]) {
      expect(allowed("author", tool), tool).toBe(true);
    }
  });

  it("deletes nothing, even on resources it may write", () => {
    // This is the gap resource scopes cannot express: `delete_item` and
    // `update_item` both require features:write.
    for (const tool of ["delete_item", "delete_goal", "delete_key_result"]) {
      expect(allowed("author", tool), tool).toBe(false);
      // Same credential, same resource, non-destructive verb: allowed.
      expect(allowed("author", "update_item")).toBe(true);
    }
  });

  it("does not administer the workspace", () => {
    for (const tool of ["link_github", "unlink_github"]) {
      // link/unlink both need features:write; only unlink is destructive.
      expect(allowed("author", "link_github")).toBe(true);
      expect(allowed("author", "unlink_github"), tool).toBe(false);
    }
  });
});

describe("full access", () => {
  it("is every tool, which is what it says", () => {
    for (const tool of TOOLS) {
      expect(allowed("full", tool.name), tool.name).toBe(true);
    }
  });
});

describe("describeStoredGrant", () => {
  it("names a stored grant as the choice that produced it", () => {
    for (const grant of CONNECTION_GRANTS) {
      expect(
        describeStoredGrant(grant.scopes, grant.allowDestructive),
        grant.id,
      ).toBe(grant.label);
    }
  });

  it("calls a pre-scoping connection what it is", () => {
    // NULL means the connection predates consent asking, and it keeps full
    // access. Saying "0 scopes" would read as the safest row on the page.
    expect(describeStoredGrant(null, false)).toContain("Full access");
  });

  it("falls back to counts for a grant that matches no preset", () => {
    expect(describeStoredGrant(["features:read", "specs:write"], true)).toBe(
      "1 read, 1 write, may delete",
    );
  });
});
