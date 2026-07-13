# Plan: end-to-end test of the dogfooding loop

Goal: prove the full PR -> work-item-status loop against a real Specboard
instance, end to end, then decide whether to roll it out more widely. This doc
is a self-contained handoff: a fresh session should be able to run the test from
here without prior context.

## What already shipped (on `main`)

The API + CLI + loop are built, deployed, and verified at the plumbing level:

- **API keys**: `x-api-key` accepted on every `/api/v1` route (lib
  `apps/web/src/lib/api-keys.ts`, table `api_keys`, migration `0018`). Settings
  -> API keys UI. `GET /api/v1/me` for identity.
- **CLI**: `apps/cli` (`specboard`): `auth`, `whoami`, `features`, `show`,
  `status`, `assign`, `link`, `products`. (The `priority` command was removed in
  v0.4.0 along with the priority field.)
- **Loop**: `.github/workflows/specboard-sync.yml` (PR opened/updated ->
  `in_progress` + link PR; merged -> `done`), `scripts/specboard/*.sh`, local
  `.githooks/pre-push`, runbook `docs/RUNBOOK-specboard-dogfood.md`.
- **Deployed + verified**: migration `0018` applied to test and prod DBs; CLI
  verified live against both `test.specboard.ai` and `app.specboard.ai` (mint a
  temp key via DB proxy -> whoami/features/products all work -> delete
  key -> 401).

What has NOT been proven: a real PR actually moving a real work item via the CI
workflow. That is what this test does.

## The one rule that makes or breaks the test

**The repo the CI workflow runs in must be the same repo whose specs were
imported into the target Specboard workspace.** The workflow resolves spec ids
from `specs/**/spec.md` frontmatter `id:` in its own checkout, then calls the
API. Those ids only resolve if that workspace imported those exact specs. Cross
a repo/workspace boundary and every call 404s and is silently skipped (a no-op).

For a real hosted customer this is automatic: they connect their repo to their
workspace AND add the workflow to that same repo, so CI-repo == connected-repo.
Our earlier friction was only because we pointed CI in `Specboards/SpecBoard` at
the `Nintex` workspace, which does not track that repo.

## Target for this test (fill in / confirm)

| Thing | Value |
| --- | --- |
| Specboard deployment | `https://app.specboard.ai` (prod) |
| Specboard workspace | "Nintex" in the app (slug `nintex`); admin `jonathan.butler@nintex.com`. Referred to loosely as the "Palouse" instance. |
| GitHub org for the repo | `StudioPalouse` (https://github.com/StudioPalouse) |
| Repo to connect + run CI in | a repo in `StudioPalouse` that is a copy of Specboard, so it already contains `apps/cli`, `scripts/specboard/`, `.github/workflows/specboard-sync.yml`, and `specs/**/spec.md`. Name it here: `__________` |
| API key | a key for the `nintex` workspace (admin). Already set as the `SPECBOARD_TOKEN` secret on `Specboards/SpecBoard`; for this test set it on the test repo instead (see step 4). |

> Naming note: the app workspace is "Nintex" (slug `nintex`); the GitHub org is
> `StudioPalouse`. "Palouse instance" is shorthand, not a separate deployment.
> If you would rather test on `test.specboard.ai` (workspace "Palouse", slug
> `palouse`, admin `jonathan@palouse.io`), swap the URL/key accordingly; the
> cloud-test-first rule actually favors that. The steps are identical.

## Prerequisites

- Fly CLI authed (`fly auth whoami`) for the DB-proxy verification.
- `gh` authed with admin on the StudioPalouse test repo (to set secrets / open PRs).
- DB apps (for proxy verification, migration `0018` already applied): legacy Fly
  Postgres as of 2026-06-29: test `specboard-test-db` (db `specboard_test`), prod
  `specboard-prod-db` (db `specboard_prod`). Recipe: see `db-migrations` memory /
  the `fly proxy 15432:5432 -a <pg-app>` + `pnpm db:migrate` (as `specboard_owner`) flow.

## Steps

### 1. Pick / create the test repo in StudioPalouse
Use a Specboard copy in `StudioPalouse` so CI-repo == connected-repo. It must
contain the CLI, the scripts, the workflow, and `specs/**/spec.md`. If it is a
fork of `Specboards/SpecBoard`, it already does.

### 2. Connect the repo in the app (browser; cannot be done via CLI)
The GitHub-App connect flow authenticates off a signed-cookie install session,
not API keys, so it must be done in the UI. In `app.specboard.ai` as the
`nintex` admin -> **Settings -> Repositories -> Connect**:
1. Install / authorize the Specboard GitHub App on the `StudioPalouse` org.
2. Select the test repo. Specboard imports its `specs/**/spec.md` as work items,
   keyed by each spec's frontmatter `id`.

### 3. Verify the import via CLI (this is the go/no-go gate)
Pick a spec id from the repo (e.g. `grep -m1 '^id:' specs/<dir>/spec.md`), then:
```bash
KEY=<nintex api key>
curl -s -o /dev/null -w '%{http_code}\n' -H "x-api-key: $KEY" \
  "https://app.specboard.ai/api/v1/features/<that-id>"
```
`200` = imported and resolvable (proceed). `404` = not tracked in this workspace
(stop; the connect/import did not land, or you connected the wrong repo).

### 4. Set secrets on the test repo
```bash
printf '%s' "$KEY" | gh secret set SPECBOARD_TOKEN --repo StudioPalouse/<repo>
printf '%s' "https://app.specboard.ai" | gh secret set SPECBOARD_URL --repo StudioPalouse/<repo>
```

### 5. Open a PR and watch the loop
- Branch off, edit a tracked `specs/<dir>/spec.md` (a comment is enough), open a
  PR with `gh pr create`. For a code-only change, add a `Spec: <id>` trailer to
  the PR body instead.
- The **Specboard Sync** action runs: it sets each touched spec `in_progress`
  and links the PR. Watch with `gh run watch` and confirm in the app.
- Merge the PR; the action sets those specs `done`.

> Status moves are best-effort. `in_progress` from `backlog` is not a legal
> transition (the workflow is `backlog -> defining -> ready -> in_progress`), so
> move the spec to `ready` in the UI first if you want that step to take. This is
> expected, documented behavior, not a bug.

### 6. (Optional) local pre-push hook
```bash
pnpm --filter @specboard/cli build && pnpm --filter @specboard/cli exec npm link
specboard auth login --url https://app.specboard.ai   # paste the key
scripts/specboard/install-hooks.sh
```
Push a branch that edits a spec; the changed specs go `in_progress`.

## Success criteria
- Step 3 returns `200` for a repo spec id.
- Opening the PR moves at least one work item to `in_progress` and links the PR.
- Merging moves it to `done`.

## Cleanup
- Remove any temporary API keys minted via the DB proxy
  (`delete from api_keys where name='cli-verify-temp';`).
- The test repo connection and secrets can stay if you want the loop ongoing.

---

## Future implementation items (noted, not in scope for the test)

Captured so they are not lost when context is cleared:

**Productize the loop for customers**
- Extract `specboard-sync.yml` into a **reusable workflow** (`workflow_call`) or
  a composite Action so a customer enables it with ~5 lines in their repo
  instead of copying the whole file + scripts. Document the snippet.
- **CLI distribution**: publish `@specboard/cli` (npm) and/or a Homebrew formula
  so `specboard` installs without building from the monorepo.
- A **dedicated bot user** per workspace (the current key is a real admin user;
  sync actions are attributed to them). Consider a `service`/`bot` role.

**API surface still deferred (from the audit; not needed by the current CLI)**
- Missing verbs: `GET /api/v1/products/[id]`, `GET` + `PATCH
  /api/v1/repositories/[id]`, `PATCH /api/v1/views/[id]`.
- Leaf-feature creation via API (currently spec-sync only) if the CLI should
  ever create specs rather than read git-born ones.
- Pagination on list endpoints (none today; fine until workspaces get large).
- An OpenAPI / schema document (none exists; `api-client.ts` is the de-facto spec).
- Normalize the inline admin checks in `levels` PUT and `workspace` PATCH to use
  `authorizeOrgAdmin`; revisit the `501` "authenticated-but-no-DB" branches.
- No comments API endpoint exists; add one if hooks should post comments.
- API keys are full-user (no scopes) and unthrottled; consider scoped keys and
  rate limiting on `/api/v1` before exposing keys widely.

**Loop ergonomics**
- Option to auto-advance a spec through `defining -> ready -> in_progress` so the
  loop is not blocked by the state machine on `backlog` items.

**Housekeeping owed elsewhere**
- Website repo (`Specboards/Website`): add the `FLY_API_TOKEN` deploy secret.
- This repo: retire the now-dead `FLY_API_TOKEN_MARKETING` secret.
- Production app currently runs the new code; if you want the API-keys UI live
  for end users, it already is (deployed this cycle).
