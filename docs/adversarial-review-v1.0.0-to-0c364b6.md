# Adversarial review: v1.0.0 to 0c364b6

Date: 2026-09-15

Baseline: `v1.0.0` (`6b634887`, 2026-09-02)

Reviewed head: `0c364b6` (2026-09-15)

## Executive summary

The change set builds and its unit, type, lint, dead-code, and production
dependency checks pass. The review nevertheless found five issues that should
be treated as release-significant:

1. An MCP caller can report progress against another agent's run.
2. Agent run updates are not atomic and can undo cancellation, lose steering,
   lose trace steps, or create duplicate active runs.
3. Proposal application is neither crash-consistent nor protected against a
   target changing after its freshness check.
4. Item conversion validates a snapshot and later writes a different snapshot,
   allowing hierarchy and attachment invariants to be invalidated by a race.
5. Avatar uploads enforce the 256 KB limit only after Next.js has buffered and
   parsed the complete multipart request.

One additional product-correctness issue was found in MCP stage-gate
inheritance. There is also a deliberate but important release constraint:
databases currently on v1.0.0 cannot upgrade directly to v1.0.2 or later.

Recommended release posture: resolve findings AR-01 through AR-05 before the
next production release. Resolve AR-06 in the same cycle if MCP stage gates are
enabled for product-specific workflows. Make the v1.0.0 upgrade hop explicit in
release-facing operator instructions before rollout.

## Scope and method

The review covered the committed diff `v1.0.0..0c364b6`: 67 commits, 529 files,
and 46,628 additions. Of those, 510 changed files are under `apps`, `packages`,
or `infra`. The large deletion count is primarily the migration-history squash.

The audit emphasized trust boundaries and failure modes in:

- MCP authorization and agent run lifecycle
- proposal review and application
- item conversion and stage gates
- public portal and email flows
- authentication and bootstrap
- uploads and request-body limits
- row-level security and migration compatibility

The only pre-existing uncommitted changes were `AGENTS.md` and `CLAUDE.md`.
They were not modified and were not treated as product-code changes.

## Findings

### AR-01: A caller can mutate another agent's run

Priority: P1

Affected code:

- `apps/web/src/lib/mcp/run-tools.ts:109-116`
- `apps/web/src/lib/runs/service.ts:149-196`
- `apps/web/src/lib/runs/store.ts:110-124`
- `infra/migrations/0016_agent_runs.sql:142-152`

The reporting tool derives the caller's identity when it opens a run, but the
report path accepts only a caller-supplied `runId`. `reportRun` loads that row by
workspace and ID, then updates it without verifying that `run.agentId` equals
the MCP caller's `scope.userId`. The update RLS policy permits any workspace
member, so it does not restore the missing ownership check.

An API key or service account with `runs:write` can therefore update any run it
can address and read through product RLS. It can replace the summary, add or
replace trace state, clear a steering note, and report the run as succeeded or
failed. A UUID is an identifier, not an authorization boundary.

Impact: the run audit trail and its control channel can be falsified across
agents. A malicious or confused agent can claim another agent finished, erase
pending steering, or attach misleading execution detail to another identity.

Recommended fix:

- Pass the authenticated actor ID into the report mutation and require
  `agent_id = scope.userId` in the update predicate.
- Keep human cancel and steer operations as separate mutations with their own
  authorization rules.
- Consider a narrower RLS policy or a database function for agent-authored
  reports so the invariant does not depend on every application caller.

Required regression test: open runs for two service accounts, then prove that
account A cannot report account B's run even when both can read the target.

### AR-02: The run state machine is vulnerable to lost updates and duplicate runs

Priority: P1

Affected code:

- `apps/web/src/lib/runs/service.ts:104-138`
- `apps/web/src/lib/runs/service.ts:149-203`
- `apps/web/src/lib/runs/store.ts:135-187`
- `apps/web/src/lib/runs/store.ts:198-217`
- `infra/migrations/0016_agent_runs.sql:100-105`

`reportRun` reads a run, derives a full replacement trace and steering value in
memory, and then updates by only `id` and `workspace_id`. That update has no
expected status, version, or active-state predicate.

Concrete races:

- A report reads `running`, a person cancels the run, and the report then writes
  `running` or `succeeded`. Cancellation has been undone.
- A report reads the old steering slot, a person writes a new note, and the
  report then writes `steer = null`. The note is lost without delivery.
- Two progress reports read the same trace and each write a replacement array.
  One trace step is lost. A late `running` write can also regress a terminal
  status and clear `finished_at`.
- `openRun` performs `findActiveRun` followed by `createRun`. The active-run
  index is not unique, so two concurrent opens can create two active runs for
  the same agent and target.

Impact: cancellation is not reliable, human steering can disappear, the audit
trace can omit work, and the UI can show multiple supposedly impossible active
runs.

Recommended fix:

- Make reporting a conditional update from an allowed active state, returning a
  conflict or the winning terminal state when the predicate no longer matches.
- Append trace steps and exchange the steering slot atomically in SQL, or lock
  the row in one transaction before reading and writing it.
- Add an optimistic version column if multiple writers must remain supported.
- Add a partial unique index over workspace, agent, target type, and target ID
  for active statuses. Handle the uniqueness conflict by loading the winner.

Required regression tests: deterministic two-connection tests for
report-versus-cancel, report-versus-steer, concurrent reports, and concurrent
opens.

### AR-03: Proposal application can report success without applying, or overwrite a fresh edit

Priority: P1

Affected code:

- `apps/web/src/lib/proposals/service.ts:70-103`
- `apps/web/src/lib/proposals/store.ts:197-275`
- `apps/web/src/lib/proposals/handlers.ts:184-255`
- `apps/web/src/lib/proposals/handlers.ts:288-314`

The apply path checks permissions and freshness in `prepare`, marks the proposal
as `applied`, performs the target write, and then records the result. These are
separate operations and, for database-backed targets, are not guarded by a
target version comparison.

There are two independent failure classes:

- A process exit after `claim` but before the target write leaves an `applied`
  proposal whose change never happened. A failure after the target write but
  before `recordResult` leaves an applied change without its recorded outcome.
  The `catch` can release a normal exception, but it cannot repair a killed
  process or a failed final result write.
- A human can edit release notes, DB-native content, or item metadata after the
  `prepare` freshness check and before `handler.apply`. The proposal then
  overwrites the newer value even though the feature explicitly claims to
  reject stale proposals. Git-backed spec content has an expected blob SHA,
  but the database-backed handlers do not have an equivalent compare-and-set.

Impact: the review record can disagree with the target, and applying a proposal
can silently discard a concurrent human edit.

Recommended fix:

- For database targets, claim, re-check the target version, mutate the target,
  and record the result in one transaction.
- Use an explicit `applying` state and an idempotency/reconciliation strategy for
  operations, such as Git commits, that cannot share the database transaction.
- Carry the exact prepared target version into the write predicate. A mismatch
  should reopen or fail the proposal without changing the target.

Required regression tests: pause between prepare and apply, mutate the same
field from another connection, and prove the proposal does not overwrite it.
Also simulate interruption immediately after claim and after target mutation.

### AR-04: Item conversion uses stale validation to perform an unconditional write

Priority: P1

Affected code:

- `apps/web/src/lib/convert-item-service.ts:34-68`
- `apps/web/src/lib/convert-item-service.ts:74-127`
- `apps/web/src/lib/store/db/items-write.ts:686-760`

`buildPlan` reads the item, parent, children, workflow, gates, fields, and gate
completions through several queries. `convertItem` later calls
`convertFeatureLevel`, whose own comment says it does not re-derive the safety
rules. The write reloads only a small part of the item and updates its level and
possibly parent without checking that the planned snapshot is still current.

Between planning and writing, another request can add a child, attach a spec,
change the parent, move the item, change a required field, or change the
workflow configuration. The conversion can then create a hierarchy that the
planner would have rejected, detach a newly assigned parent, or convert an item
whose current attachment or gates make the destination illegal.

Impact: persistent item data can violate the hierarchy and attachment rules
that conversion exists to protect. The emitted event can also describe the old
plan rather than the state that was actually changed.

Recommended fix:

- Re-plan and write inside one transaction with row locks over the item and
  hierarchy rows involved, plus a stable configuration version.
- If broad locking is undesirable, carry `updated_at` or a dedicated revision
  for every relevant object into compare-and-set predicates and retry the plan
  on conflict.
- Keep preview advisory. Treat the execute request as a fresh validation, not as
  permission to apply an earlier preview.

Required regression tests: add a child, attach a spec, and replace a parent from
a second connection after planning but before the write. Each conversion must
be rejected or safely re-planned.

### AR-05: The avatar size limit is enforced after the request is buffered

Priority: P1

Affected code:

- `apps/web/src/app/api/v1/profile/avatar/route.ts:45-80`
- `apps/web/src/lib/api/body.ts:39-103`

The avatar route calls `req.formData()` before inspecting the uploaded file's
size. By that point Next.js has already consumed and parsed the complete
multipart body. The later 256 KB checks protect storage, but they do not bound
request memory or parsing work.

The shared JSON and raw-text readers explicitly stream and stop at a byte limit
because the deployment has no outer request-size cap and runs on a 512 MB
machine. The multipart route bypasses that protection. Any authenticated user
can send a very large or chunked multipart request and consume resources before
receiving the 413 response.

Impact: an ordinary authenticated account can cause memory pressure, worker
termination, or a small-instance outage. Repetition turns this into a practical
denial-of-service path.

Recommended fix:

- Reject a declared multipart length above a small envelope before parsing.
- Use a streaming multipart parser that stops after the aggregate and file byte
  ceilings; do not rely on `Content-Length` for chunked requests.
- Add a proxy-level body cap as defense in depth, with route-specific handling
  if other endpoints legitimately need larger bodies.

Required regression test: send a chunked multipart stream larger than the cap
and assert that the reader cancels near the limit rather than consuming the
remainder.

### AR-06: MCP applies workspace gates when a product owns a different gate set

Priority: P2

Affected code:

- `apps/mcp/src/server.ts:800-837`

The code intends set-level inheritance: if a product defines any stage gates,
its set replaces the workspace default set. The query first filters rows to the
stages crossed by the current transition, then decides whether the product has
an owned set by checking only those filtered rows.

Example: a product has its own gate only at `ready`. An agent advances an item
across `backlog`, where the product has no gate. Because no product row survives
the stage filter, MCP falls back to the workspace's `backlog` gate. The web path
resolves the complete product set first and would not apply that default.

Impact: agent transitions can be rejected even though the same transition is
valid in the web app. This is a false denial rather than a gate bypass, but it
breaks parity between human and agent workflows and can strand automation.

Recommended fix: determine whether the product owns any gate before filtering
to crossed stages, or load the resolved complete set and then filter it.

Required regression test: give a product a gate on an unrelated stage and prove
that MCP does not inherit a workspace default gate on the current stage.

## Release constraint: v1.0.0 needs an intermediate database upgrade

The migration squash in v1.0.2 deliberately refuses a database that has old
migration records but lacks `public.user_avatars`. That sentinel was introduced
in v1.0.1. A database running exactly v1.0.0 therefore cannot migrate directly
to v1.0.2, v1.1.x, v1.2.x, or current head. It must first run v1.0.1 or another
release that still contains the full pre-squash history.

Evidence:

- v1.0.0 contains no `user_avatars` migration.
- v1.0.1 adds it in `0080_user_avatars_and_field_gates.sql`.
- `packages/db/src/migrate.ts:105-161` refuses the older partial-history state.
- `infra/migrations/README.md:42-54` documents the recovery hop.

This fail-closed behavior is safer than silently accepting a partial schema, so
it is not classified as a code defect. It is still an operational release risk:
an operator following a normal direct-upgrade pattern from v1.0.0 will get a
failed deployment. The intermediate-hop instruction should be prominent in the
release notes and operator upgrade guide, and the v1.0.1 image must remain
available.

## Verification performed

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed |
| `pnpm test` | Passed |
| Direct web Vitest run | 138 files, 1,525 tests passed |
| `pnpm build` | Passed, including a fresh web production build |
| `pnpm knip` | Passed |
| `pnpm run audit` | Passed; no unsuppressed production advisory at moderate or above |
| `git diff --check v1.0.0..HEAD` | Failed on four whitespace-only findings |

The full all-dependency audit also reports a high-severity `js-yaml` advisory
through ESLint tooling. The same vulnerable lockfile version is already present
at v1.0.0, and the package is not on the production dependency path, so it is
outside this change-set review and is not counted as a new production finding.

Database integration and browser end-to-end suites were not run because no
Docker daemon or test database was available in this environment. The absence
of concurrent database tests is material to AR-01 through AR-04: the unit suite
does not exercise these multi-connection race conditions.

## Lower-priority hygiene

`git diff --check v1.0.0..HEAD` reports trailing whitespace in `CHANGELOG.md`
and blank lines at end of file in `sidebar-profile.tsx`, `proposals/handlers.ts`,
and `proposals/store.ts`. These are not release-significant.
