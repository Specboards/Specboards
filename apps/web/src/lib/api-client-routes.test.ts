import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every request the browser API client sends must reach a route that exports
 * that method.
 *
 * This exists because nothing else checks it, and the gap cost us a shipped
 * feature. #259 rewrote `api/v1/statuses/route.ts` to make Settings > Cards
 * per-product and dropped its `PUT` export on the way through. The client kept
 * sending `PUT /api/v1/statuses`, so Save workflow, "Override for this product"
 * and "Revert to workspace default" all returned 405. Nothing failed:
 * typecheck cannot see across an HTTP boundary, the OpenAPI document was
 * updated to match the route rather than the client, and no test drove that
 * button. It sat broken in main.
 *
 * A string-level check rather than a type-level one, because that boundary is
 * genuinely stringly-typed: the client builds a URL and Next resolves it
 * against the filesystem. The test is deliberately noisy about what it cannot
 * resolve (see UNRESOLVED) so coverage cannot quietly shrink.
 */

const SRC = resolve(__dirname, "..");
const APP_DIR = join(SRC, "app");
const CLIENT_ENTRY = join(SRC, "lib", "api-client.ts");
const CLIENT_DIR = join(SRC, "lib", "api-client");

interface ClientSource {
  path: string;
  source: string;
}

/** The compatibility entry point plus every focused client module. */
function clientSources(): ClientSource[] {
  const sources = [
    { path: CLIENT_ENTRY, source: readFileSync(CLIENT_ENTRY, "utf8") },
  ];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        sources.push({ path: full, source: readFileSync(full, "utf8") });
      }
    }
  };
  walk(CLIENT_DIR);
  return sources;
}

/**
 * Call sites whose URL is not a literal, so no static reading can say where
 * they go. Each is checked by hand; the test asserts this list is exactly the
 * unresolved set, so a new one has to be added deliberately rather than
 * silently escaping the check.
 */
const UNRESOLVED: { snippet: string; why: string }[] = [
  {
    snippet: "apiFetch(path, {",
    why: "goalRequest's shared helper: `path` is a parameter, supplied by callers that do not themselves call apiFetch.",
  },
];

/** Every `route.ts` under src/app, keyed by its URL path with [params] intact. */
function routeTable(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Route groups `(name)` do not appear in the URL.
        const segment = /^\(.*\)$/.test(entry) ? "" : `/${entry}`;
        walk(full, url + segment);
      } else if (entry === "route.ts") {
        out.set(url || "/", readFileSync(full, "utf8"));
      }
    }
  };
  walk(APP_DIR, "");
  return out;
}

/**
 * Resolve a URL path to its route source, preferring a literal segment over a
 * `[param]` one so `/repositories/import` matches its own route rather than
 * `/repositories/[id]`, exactly as Next.js resolves it.
 */
function routeFor(
  table: Map<string, string>,
  path: string,
): { pattern: string; source: string } | null {
  const segs = path.split("/").filter(Boolean);
  let best: { pattern: string; source: string; literals: number } | null = null;
  for (const [pattern, source] of table) {
    const pSegs = pattern.split("/").filter(Boolean);
    if (pSegs.length !== segs.length) continue;
    let literals = 0;
    let ok = true;
    for (const [i, pSeg] of pSegs.entries()) {
      if (pSeg.startsWith("[")) continue;
      if (pSeg !== segs[i]) {
        ok = false;
        break;
      }
      literals += 1;
    }
    if (ok && (!best || literals > best.literals)) {
      best = { pattern, source, literals };
    }
  }
  return best ? { pattern: best.pattern, source: best.source } : null;
}

/** `/api/v1/features/${encodeURIComponent(id)}?x=1` -> `/api/v1/features/x`. */
function normalize(url: string): string {
  return url
    .split("?")[0]!
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/\/+$/, "");
}

interface Call {
  path: string;
  method: string;
  raw: string;
}

/** Every apiFetch call in the client, with the method it sends. */
function clientCalls(source: string): { calls: Call[]; unresolved: string[] } {
  // `const base = `/api/...`;` so a call built from it can still be resolved.
  const consts = new Map<string, string>();
  for (const m of source.matchAll(
    /const (\w+)\s*=\s*[`"](\/api\/[^`"]*)[`"]/g,
  )) {
    consts.set(m[1]!, m[2]!);
  }

  const calls: Call[] = [];
  const unresolved: string[] = [];
  for (const m of source.matchAll(
    /apiFetch\(\s*([`"][^`"]*[`"]|\w+)\s*(,?)/g,
  )) {
    // `function apiFetch(input: string, ...)` is the definition, not a call.
    if (
      /function\s+$/.test(source.slice(Math.max(0, m.index! - 10), m.index!))
    ) {
      continue;
    }
    const rawArg = m[1]!;
    let url: string | null = null;
    if (rawArg.startsWith("`") || rawArg.startsWith('"')) {
      url = rawArg.slice(1, -1);
      // A template that opens with a local const, e.g. `${base}?specId=...`.
      const lead = /^\$\{(\w+)\}/.exec(url);
      if (lead && consts.has(lead[1]!)) {
        url = consts.get(lead[1]!)! + url.slice(lead[0].length);
      }
    } else if (consts.has(rawArg)) {
      url = consts.get(rawArg)!;
    }

    if (url === null || !normalize(url).startsWith("/api/")) {
      unresolved.push(
        source
          .slice(m.index!, m.index! + 20)
          .replace(/\s+/g, " ")
          .trim(),
      );
      continue;
    }

    // The method literal belongs to this call's init object, which begins
    // immediately after the comma. A bare apiFetch(url) is a GET.
    let method = "GET";
    if (m[2]) {
      const tail = source.slice(m.index! + m[0].length, m.index! + 400);
      const mm = /method:\s*"([A-Z]+)"/.exec(tail);
      // Stop at the next apiFetch so a bare GET cannot borrow the next call's
      // method.
      const nextCall = tail.indexOf("apiFetch(");
      if (mm && (nextCall === -1 || mm.index < nextCall)) method = mm[1]!;
    }
    calls.push({ path: normalize(url), method, raw: url });
  }
  return { calls, unresolved };
}

describe("api-client reaches routes that exist", () => {
  const sources = clientSources();
  const parsed = sources.map(({ source }) => clientCalls(source));
  const calls = parsed.flatMap((result) => result.calls);
  const unresolved = parsed.flatMap((result) => result.unresolved);
  const table = routeTable();

  it("finds the client's calls and the app's routes", () => {
    // Guards the parsing itself: if a refactor breaks these regexes the suite
    // must fail loudly rather than pass by checking nothing.
    for (const clientModule of [
      "assistant.ts",
      "notifications.ts",
      "planning.ts",
      "repositories.ts",
      "specs.ts",
      "work-items.ts",
    ]) {
      expect(
        sources.some(({ path }) =>
          path.endsWith(join("api-client", clientModule)),
        ),
      ).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(80);
    expect(table.size).toBeGreaterThan(50);
  });

  it("sends no request to a route that does not handle it", () => {
    const broken: string[] = [];
    for (const call of calls) {
      const route = routeFor(table, call.path);
      if (!route) {
        broken.push(`${call.method} ${call.path} -> no route file`);
        continue;
      }
      const exported = new RegExp(
        `export\\s+(async\\s+)?function\\s+${call.method}\\b`,
      ).test(route.source);
      if (!exported) {
        broken.push(
          `${call.method} ${call.path} -> ${route.pattern} exports no ${call.method} handler (Next returns 405)`,
        );
      }
    }
    expect(broken).toEqual([]);
  });

  it("resolves every call site except the ones known not to be resolvable", () => {
    expect(unresolved).toEqual(UNRESOLVED.map((u) => u.snippet));
  });
});
