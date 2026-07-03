# Specboard CLI

`specboard` manages your Specboard work items (status, assignment, and GitHub
links) from the terminal. It talks to the same `/api/v1` surface the web app
uses, authenticating with a personal API key.

## Install (from the monorepo)

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
status <specId> <status>                 Set a feature's status
assign <specId> <me|none|userId>         Set or clear the assignee
link <specId> (--pr <n> | --issue <n> | --branch <name>)
products                                 List products
```

Statuses: `backlog`, `defining`, `ready`, `in_progress`, `in_review`, `done`,
`archived` (status changes are validated against the workflow state machine).

## Example: a Git hook that advances a spec on PR open

```bash
# .git/hooks or CI: when a PR opens, mark its spec in_progress and link the PR.
specboard status "$SPEC_ID" in_progress
specboard link "$SPEC_ID" --pr "$PR_NUMBER"
```
