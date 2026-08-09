import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * How every API route is allowed to authenticate.
 *
 * `getSessionUser()` was named for browser sessions but resolved API keys
 * first, so ten routes that describe themselves as interactive flows (GitHub
 * OAuth starts and callbacks, disconnecting a GitHub credential, the MCP
 * consent binding) accepted an `sb_` key. Those routes do not call the
 * authorize helpers, so no scope or quota enforcement ran on them either: a key
 * scoped `features:read` could disconnect its owner's GitHub account.
 *
 * The rename is what fixed it, but a rename does not stay fixed. This walks the
 * route tree and holds the line: a route authenticates through one of the
 * approved helpers, and nothing hand-rolls credential resolution.
 */

const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));

/** Every `route.ts` under `src/app/api`, repo-relative for readable failures. */
async function routeFiles(dir = API_DIR, rel = "api"): Promise<
  { path: string; source: string }[]
> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: { path: string; source: string }[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await routeFiles(full, `${rel}/${entry.name}`)));
    } else if (entry.name === "route.ts") {
      out.push({ path: `${rel}/route.ts`, source: await readFile(full, "utf8") });
    }
  }
  return out;
}

/**
 * The sanctioned ways to identify a caller.
 *
 * - `resolveReadScope` / `resolveReadAccess` / `authorizeWrite` /
 *   `authorizeOrgAdmin` accept API keys AND enforce their scopes and quota.
 * - `getBrowserSessionUser` is cookie-only, for interactive flows.
 * - `getServerSessionUser` is the same, for server components.
 */
const APPROVED = [
  "resolveReadScope",
  "resolveReadAccess",
  "authorizeWrite",
  "authorizeOrgAdmin",
  "getBrowserSessionUser",
  "getServerSessionUser",
  // Not an authenticator: reads the org the caller named, validated downstream.
  "orgSlugFromRequest",
  // Types, not behaviour.
  "SessionUser",
  "ScopeResult",
  "ReadAccessResult",
  "CredentialInfo",
];

describe("API route authentication", () => {
  it("imports only sanctioned auth helpers", async () => {
    const offenders: string[] = [];
    for (const { path, source } of await routeFiles()) {
      const match = /import\s*{([^}]*)}\s*from\s*"@\/lib\/auth-session"/.exec(source);
      if (!match) continue;
      const imported = match[1]!
        .split(",")
        .map((s) => s.replace(/^\s*type\s+/, "").trim())
        .filter(Boolean);
      for (const name of imported) {
        if (!APPROVED.includes(name)) offenders.push(`${path}: ${name}`);
      }
    }
    // A new name here means a new way to authenticate. Add it to APPROVED only
    // once you have decided whether it enforces key scopes, and said so in its
    // own doc comment.
    expect(offenders).toEqual([]);
  });

  it("does not let a route resolve a session or a key by hand", async () => {
    const offenders: string[] = [];
    for (const { path, source } of await routeFiles()) {
      // Reaching past the helpers is how a route ends up accepting a credential
      // nobody checked the scopes of.
      if (/auth\.api\.getSession\b/.test(source)) {
        offenders.push(`${path}: auth.api.getSession`);
      }
      if (/\bverifyApiKey\b/.test(source)) {
        offenders.push(`${path}: verifyApiKey`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the interactive GitHub and MCP flows on cookie-only auth", async () => {
    // Named explicitly: these are the routes the review found, and a silent
    // move back to a key-accepting helper is exactly the regression to catch.
    const cookieOnly = [
      "api/mcp/workspace-binding/route.ts",
      "api/v1/github/user/connection/route.ts",
      "api/v1/github/user/connect/route.ts",
      "api/v1/github/user/callback/route.ts",
      "api/v1/github/install-start/route.ts",
      "api/v1/github/setup/route.ts",
      "api/v1/github/oauth/callback/route.ts",
      "api/v1/github/app/create/route.ts",
      "api/v1/github/app/callback/route.ts",
      "api/v1/workspaces/route.ts",
    ];
    const byPath = new Map((await routeFiles()).map((r) => [r.path, r.source]));
    for (const path of cookieOnly) {
      const source = byPath.get(path);
      expect(source, `${path} should exist`).toBeDefined();
      expect(source, path).toContain("getBrowserSessionUser");
    }
  });
});
