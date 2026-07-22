# Runbook: Specboards for Specboards (dogfooding)

> Internal: this documents how Studio Palouse runs Specboards on its own repo.
> You do not need it to self-host. For wiring the PR -> status sync loop into
> your own repo, see [`RUNBOOK-github-sync.md`](./RUNBOOK-github-sync.md).

We track Specboards' own development in Specboards, driven from the CLI so status
follows the actual work instead of being updated by hand.

## The loop

| Trigger | Effect |
| --- | --- |
| Push a feature branch (local `pre-push` hook) | Touched specs go `in_progress` |
| Open / update a PR (CI: `specboards-sync.yml`) | Touched specs go `in_progress`, the PR is linked |
| Merge the PR (CI) | Touched specs go `done` |

"Touched specs" = any changed `specs/**/spec.md` (resolved by its frontmatter
`id:`), plus any `Spec: <id>` line in the PR body. Use the trailer for code-only
PRs that don't edit a spec file.

The sync uses `specboards status ... --advance`, which walks a spec through the
intermediate statuses, so `in_progress` straight from `backlog` now advances
through `defining` and `ready` automatically instead of being skipped. It stays
best-effort: if no legal path to the target exists the step is logged and
skipped, never fatal.

## One-time setup

### 1. A service account + scoped API key

Create a dedicated **service account** so sync activity is attributed to a bot,
not a human. As an owner (from a browser session), call `POST
/api/v1/org/service-accounts` with a name and the scopes it needs -
`features:write` (status changes + PR links) and `statuses:read` (so
`--advance` can read the workflow):

```bash
curl -X POST https://app.specboards.ai/api/v1/org/service-accounts \
  -H 'content-type: application/json' --cookie "$SESSION" \
  -d '{"name":"CI sync bot","scopes":["features:write","statuses:read"]}'
```

The response returns the `sb_…` key once. (A personal full-access key under
**Settings -> API keys** also works, but attributes activity to you.)

### 2. Repo secrets (for CI)

In the GitHub repo settings, add:

- `SPECBOARDS_URL` - the deployment, e.g. `https://app.specboards.ai` (use
  `https://test.specboards.ai` while validating).
- `SPECBOARDS_TOKEN` - the `sb_…` API key.

Without both, `specboards-sync.yml` no-ops, so forks and outside contributors are
unaffected.

### 3. Local hooks (per clone, optional)

```bash
pnpm --filter @specboards/cli build
pnpm --filter @specboards/cli exec npm link    # puts `specboards` on PATH
specboards auth login --url https://app.specboards.ai
scripts/specboards/install-hooks.sh            # sets core.hooksPath=.githooks
```

The `pre-push` hook is non-blocking: it only acts when `specboards` is installed
and logged in, and never fails a push. Skip it once with `SPECBOARDS_SKIP_HOOK=1
git push`.

## Files

- `apps/cli/` - the `specboards` CLI.
- `scripts/specboards/resolve-spec-ids.sh` - maps a diff / PR body to spec ids.
- `scripts/specboards/sync-pr.sh` - the CI sync logic (in_progress/link/done).
- `.github/workflows/specboards-sync.yml` - runs sync-pr.sh on PR events.
- `.github/workflows/specboards-sync-reusable.yml` - the reusable (`workflow_call`)
  version other repos enable with a ~5-line caller (runs the published CLI via
  `npx`); see `apps/cli/README.md`.
- `.githooks/pre-push` + `scripts/specboards/install-hooks.sh` - the local hook.

## Verify

Open a PR that edits a `specs/**/spec.md` (or add a `Spec: <id>` trailer), then
check the Action log under **Specboard Sync** and the item's status + linked PR
in the app. Start against `test.specboards.ai` before pointing CI at production.
