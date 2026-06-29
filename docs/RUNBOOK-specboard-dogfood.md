# Runbook: SpecBoard for SpecBoard (dogfooding)

We track SpecBoard's own development in SpecBoard, driven from the CLI so status
follows the actual work instead of being updated by hand.

## The loop

| Trigger | Effect |
| --- | --- |
| Push a feature branch (local `pre-push` hook) | Touched specs go `in_progress` |
| Open / update a PR (CI: `specboard-sync.yml`) | Touched specs go `in_progress`, the PR is linked |
| Merge the PR (CI) | Touched specs go `done` |

"Touched specs" = any changed `specs/**/spec.md` (resolved by its frontmatter
`id:`), plus any `Spec: <id>` line in the PR body. Use the trailer for code-only
PRs that don't edit a spec file.

Status moves are best-effort: a transition the workflow state machine rejects
(e.g. `in_progress` straight from `backlog`) is logged and skipped, never fatal.
Move specs through `defining` -> `ready` in the UI first if you want the
`in_progress` step to take.

## One-time setup

### 1. A bot user + API key

Create (or reuse) a SpecBoard user for automation, sign in, and generate a key
under **Settings -> API keys**. Copy the `sb_…` value once.

### 2. Repo secrets (for CI)

In the GitHub repo settings, add:

- `SPECBOARD_URL` - the deployment, e.g. `https://app.specboard.ai` (use
  `https://test.specboard.ai` while validating).
- `SPECBOARD_TOKEN` - the `sb_…` API key.

Without both, `specboard-sync.yml` no-ops, so forks and outside contributors are
unaffected.

### 3. Local hooks (per clone, optional)

```bash
pnpm --filter @specboard/cli build
pnpm --filter @specboard/cli exec npm link    # puts `specboard` on PATH
specboard auth login --url https://app.specboard.ai
scripts/specboard/install-hooks.sh            # sets core.hooksPath=.githooks
```

The `pre-push` hook is non-blocking: it only acts when `specboard` is installed
and logged in, and never fails a push. Skip it once with `SPECBOARD_SKIP_HOOK=1
git push`.

## Files

- `apps/cli/` - the `specboard` CLI.
- `scripts/specboard/resolve-spec-ids.sh` - maps a diff / PR body to spec ids.
- `scripts/specboard/sync-pr.sh` - the CI sync logic (in_progress/link/done).
- `.github/workflows/specboard-sync.yml` - runs sync-pr.sh on PR events.
- `.githooks/pre-push` + `scripts/specboard/install-hooks.sh` - the local hook.

## Verify

Open a PR that edits a `specs/**/spec.md` (or add a `Spec: <id>` trailer), then
check the Action log under **SpecBoard Sync** and the item's status + linked PR
in the app. Start against `test.specboard.ai` before pointing CI at production.
