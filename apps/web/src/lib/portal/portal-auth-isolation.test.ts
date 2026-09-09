import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The portal must not be able to read the session, and this is what says so.
 *
 * ── Why a static check, and why it is not paranoia ─────────────────────────
 * The portal was originally going to live at `{slug}.specboards.ai`. A separate
 * origin meant the app's session cookie never arrived, so "the portal cannot
 * read the session" was true by construction and needed no enforcing.
 *
 * That design was dropped because it required wildcard DNS and a wildcard
 * certificate, which a self-hosted deployment on an internal network or
 * `localhost:3000` cannot get. `/{org}/ideas` works everywhere, and the price
 * is exactly this: a signed-in admin browsing their own portal now sends their
 * session with every request, and the portal's pages sit in the same route tree
 * as 23 authenticated ones.
 *
 * Nothing structural stops somebody adding `requireWorkspaceAccess()` to a
 * portal page. There is no `[org]/layout.tsx` to enforce it, auth is a per-page
 * convention, and the resulting bug would render a customer's private backlog
 * on a public URL while every test still passed. So the guarantee the origin
 * boundary used to provide is asserted here instead.
 *
 * Static rather than behavioural on purpose. A runtime test can only prove the
 * pages that exist today behave; this fails the moment somebody *writes* the
 * import, in the diff that introduces it, naming the file and the symbol.
 */

/** Portal source: the public route tree and the modules written for it. */
const PORTAL_PATHS = [
  join(process.cwd(), "src", "app", "[org]", "ideas"),
  join(process.cwd(), "src", "lib", "portal"),
  join(process.cwd(), "src", "components", "portal"),
];

/**
 * Names a portal file must not contain, each for its own reason.
 *
 * `resolvePortal` is the one intended way in, and it uses `getPortalDb`
 * directly. Everything below either demands a membership a visitor has not got,
 * or reads on a connection whose policies are not the portal's.
 */
const FORBIDDEN: { name: string; why: string }[] = [
  {
    name: "requireWorkspaceAccess",
    why: "validates a membership; a portal visitor has none and must not need one",
  },
  {
    name: "resolveActiveWorkspace",
    why: "resolves the org from the signed-in user rather than from the URL",
  },
  {
    name: "getAppDb",
    why: "the tenant connection, whose policies key on app.user_id",
  },
  {
    name: "getWorkerDb",
    why: "the worker connection, which reads across every workspace",
  },
  {
    name: "getDb",
    why: "the owner connection, which bypasses row-level security entirely",
  },
  {
    name: "auth-session",
    why: "reading the session is the one thing a portal page must never do",
  },
  {
    name: "getSession",
    why: "reading the session is the one thing a portal page must never do",
  },
];

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found = found.concat(sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Strip comments, so the prohibitions can be *discussed* in the prose. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("portal routes cannot reach the session", () => {
  const files = PORTAL_PATHS.flatMap((p) => sourceFiles(p)).filter(
    // This file names every forbidden symbol by definition.
    (f) => !f.endsWith("portal-auth-isolation.test.ts"),
  );

  it("finds the portal source at all", () => {
    // Guards the guard: if the paths moved, every assertion below would pass
    // vacuously and prove nothing.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes("ideas"))).toBe(true);
  });

  it.each(FORBIDDEN)("uses no $name ($why)", ({ name }) => {
    const offenders = files.filter((f) =>
      code(readFileSync(f, "utf8")).includes(name),
    );
    expect(
      offenders.map((f) => f.replace(process.cwd(), "")),
      `${name} must not appear in portal source: it would let a public page ` +
        `read data the visitor is not entitled to. Read through resolvePortal ` +
        `and getPortalDb instead.`,
    ).toEqual([]);
  });

  it("reads through the portal connection and nothing else", () => {
    // The positive half. The checks above prove the wrong doors are shut; this
    // proves the right one is open, so a portal that quietly stopped reading
    // any database and rendered empty would not pass by doing nothing.
    const resolve = readFileSync(
      join(process.cwd(), "src", "lib", "portal", "resolve.ts"),
      "utf8",
    );
    expect(resolve).toContain("getPortalDb");
  });
});
