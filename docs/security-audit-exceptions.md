# Dependency audit exceptions

The CI audit gate (`pnpm run audit`, run in `ci.yml` and on a schedule in
`security-audit.yml`) fails the build on a high or critical advisory in a
production dependency. An advisory we have reviewed and accepted is suppressed
by its GHSA id in `package.json` under `pnpm.auditConfig.ignoreGhsas`.

`package.json` cannot hold a rationale or an expiry, so every id listed there
must also appear below with why it is accepted and a date to revisit it. An
exception past its review-by date should be re-evaluated, not renewed by habit.

## Accepted exceptions

None. `pnpm run audit` passes with an empty `ignoreGhsas`, so the gate is
currently reporting on the whole production tree with nothing muted.

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
