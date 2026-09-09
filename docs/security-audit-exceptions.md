# Dependency audit exceptions

The CI audit gate (`pnpm run audit`, run in `ci.yml` and on a schedule in
`security-audit.yml`) fails the build on a **moderate** or worse advisory in a
production dependency (`LEVEL=moderate` in `scripts/audit.sh`; this page
previously said "high or critical", which understated the gate). An advisory we
have reviewed and accepted is suppressed by its GHSA id in `package.json` under
`pnpm.auditConfig.ignoreGhsas`.

`package.json` cannot hold a rationale or an expiry, so every id listed there
must also appear below with why it is accepted and a date to revisit it. An
exception past its review-by date should be re-evaluated, not renewed by habit.

## Accepted exceptions

### GHSA-82fw-gwwq-j7x9 - `vitest` / `@vitest/mocker` path traversal

- **Accepted:** 2026-09-08. **Review by:** 2026-10-08.
- **What it is:** `@vitest/mocker` registers a redirect mock's target path
  without checking it against the dev server's file-serving allowlist, so
  anything that can reach that dev server's WebSocket can read local files
  through the plugin's `load` hook. Moderate, CVSS `AV:N/AC:H/PR:N/UI:N/C:H`.
- **Why it is accepted:** the vulnerable code is not present in anything we
  ship, and not reachable in anything we run.
  - It is a **devDependency** (`apps/web`, `vitest ^3.2.6`), and
    `infra/web.Dockerfile` is a two-stage build whose runtime stage copies only
    the Next standalone trace, `migrate.mjs`, `static` and `public`. vitest is
    installed in the builder and never reaches the shipped image.
  - The sink needs the vitest dev server. We run `vitest run`, headless, with
    `environment: "node"` and no browser mode (`apps/web/vitest.config.ts`), so
    no such server is started, let alone exposed.
  - It reaches a `--prod` audit at all only through an edge that is not a real
    production dependency: `better-auth` declares `vitest` as an **optional**
    peer (`peerDependenciesMeta.vitest.optional: true`, accepting
    `^2 || ^3 || ^4`), and pnpm walks that peer link from a production package.
    The advisory is describing our own test runner, not a shipped transitive.
- **Why it is not simply fixed:** the fix is `vitest >= 4.1.11`, a major bump
  across 123 test files and 1365 tests. It was accepted here rather than
  attempted because this change exists to ship two **critical** unauthenticated
  RCE advisories in Next.js the same day, and a test-framework major belongs
  nowhere near that. An override cannot help: `better-auth>vitest` resolves to
  the workspace's own devDependency, so the version has to move for real.
- **How it goes away:** upgrade `vitest` to 4.x and retire this entry.
  better-auth already accepts `^4`, so nothing blocks it but the work of the
  upgrade itself.
- **What this costs us:** the gate is no longer reporting on the whole
  production tree with nothing muted, which it had been. This is the first
  accepted exception since the round-1 `@hono/node-server` one was retired.

## Retired exceptions

Kept so a re-opened alert is recognised as one we have already reasoned about,
rather than triaged from scratch.

### GHSA-frvp-7c67-39w9 - `@hono/node-server` serve-static path traversal

- **Accepted:** 2026-07-23. **Retired:** 2026-08-16, fixed by upgrade.
- **What it was:** a Windows-only path traversal in `serve-static` via an
  encoded backslash (`%5C`). Accepted because our deployment runs on Linux
  (Fly.io), where the code path is unreachable, and because the app does not
  serve static files through this adapter at all: the dependency arrives
  transitively via `@modelcontextprotocol/sdk`.
- **Why it was accepted rather than fixed:** at the time the only fix was in
  `@hono/node-server` 2.x, a major version the MCP SDK did not accept.
- **How it was resolved:** the fix was later backported to the 1.x line in
  1.19.15, which sits inside the `^1.19.9` range the SDK already allows. A
  `pnpm.overrides` entry of `^1.19.15` floors it there. The SDK now also accepts
  `^2.0.5`, but the override deliberately stays on 1.x: this is a security
  patch, and the smallest bump that fixes it carries the least risk. Revisit
  when there is a reason to be on 2.x beyond it being newer.
