# Specboards CLI

`specboard` manages your Specboards work items (status, assignment, and GitHub
links) from the terminal. It talks to the same `/api/v1` surface the web app
uses, authenticating with a personal API key.

## Install

Once the package is published to npm (and the Homebrew tap is set up):

```bash
# npm (run without installing)
npx @specboard/cli whoami

# npm (global)
npm install -g @specboard/cli
specboard help

# Homebrew
brew install specboard/tap/specboard
```

### From the monorepo (development, works today)

```bash
pnpm --filter @specboard/cli build
# then run the built binary
node apps/cli/dist/index.js help
# or link it onto your PATH
pnpm --filter @specboard/cli exec npm link
specboard help
```

## Authenticate

Create a key in the web app under **Settings → API keys**, then:

```bash
specboard auth login --url https://app.specboard.ai
# paste the sb_… key when prompted (input is hidden)
specboard whoami
```

Config is written to `~/.specboard/config.json` (mode 0600). The environment
variables `SPECBOARD_URL` and `SPECBOARD_TOKEN` override the file, which is handy
in CI and Git hooks.

## Commands

```
auth login [--url <url>] [--key <key>]   Save deployment URL + API key
auth logout                              Remove stored credentials
whoami                                   Show the authenticated user + workspace

features [--mine] [--status <s>]         List work items
         [--product <key>] [--assignee <id>]
show <specId>                            Show one feature
status <specId> <status> [--advance]     Set a feature's status
assign <specId> <me|none|userId>         Set or clear the assignee
link <specId> (--pr <n> | --issue <n> | --branch <name>)
products                                 List products
```

Statuses: `backlog`, `defining`, `ready`, `in_progress`, `in_review`, `done`,
`archived` (status changes are validated against the workflow state machine).

The default workflow only allows single-step moves (e.g. `backlog` reaches only
`defining`), so a jump like `backlog -> in_progress` is rejected. Pass
`--advance` to walk the spec through the shortest legal chain of intermediate
statuses automatically:

```bash
specboard status "$SPEC_ID" in_progress --advance   # backlog -> defining -> ready -> in_progress
```

## Example: a Git hook that advances a spec on PR open

```bash
# .git/hooks or CI: when a PR opens, mark its spec in_progress and link the PR.
specboard status "$SPEC_ID" in_progress --advance
specboard link "$SPEC_ID" --pr "$PR_NUMBER"
```

## CI: sync PRs to Specboards automatically

To keep work items in step with your PRs (opened -> `in_progress` + PR link,
merged -> `done`), call the reusable workflow from your repo. Add
`.github/workflows/specboard-sync.yml`:

```yaml
name: Specboards Sync
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
jobs:
  sync:
    uses: Specboards/Specboard/.github/workflows/specboard-sync-reusable.yml@main
    secrets:
      SPECBOARD_URL: ${{ secrets.SPECBOARD_URL }}
      SPECBOARD_TOKEN: ${{ secrets.SPECBOARD_TOKEN }}
```

Set the two repo secrets: `SPECBOARD_URL` (e.g. `https://app.specboard.ai`) and
`SPECBOARD_TOKEN` (an API key, ideally a `service`-account key scoped to
`features:write` and `statuses:read`).

One hard rule: the repo running this workflow must be the same repo whose specs
were imported into the target Specboards workspace, since spec ids resolve from
that repo's `specs/**/spec.md` frontmatter.
