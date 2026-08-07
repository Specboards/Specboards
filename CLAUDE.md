# Project instructions for Claude

## Building philosophy

- **Tracer bullets.** When building a feature, first build the smallest possible
  end-to-end slice that runs through every layer of the system (UI, API, data,
  and any integration it touches), even if each layer is thin or stubbed. Get it
  working and visible, seek feedback, then expand outward from that proven path.
  The goal is the fastest possible feedback: a thin slice that actually runs
  surfaces architectural problems and wrong assumptions early, while they are
  cheap to fix, and confirms the overall shape is sound before we invest in
  breadth or polish. Prefer a working narrow slice over a complete-but-untested
  layer. (From The Pragmatic Programmer.)

## Working items in Specboard

- **Keep the item's status matching the work actually happening to it.** We
  dogfood Specboard to track our own work, so a board that lags reality is worse
  than no board. When work on a Specboard item starts, move the item to the
  stage that describes that work, and move it on as the work changes shape. Do
  this as part of the work, not as a cleanup pass at the end, and do it without
  being asked each time.
- **The workflow is ordered and strict**, so stages must be walked in sequence:
  `backlog` -> `defining` -> `ready` -> `in_progress` -> `in_review` -> `done`
  (plus `archived`, reachable from anywhere and returning to `backlog`). To skip
  ahead several stages, make one `update_item` call with `advance: true` rather
  than one call per stage. Call `list_statuses` (or read an item's
  `allowedTransitions`) if you need to confirm the keys before moving something.
- **Which stage matches which work:**
  - `defining` - breaking an item down, writing or revising its spec, drafting
    acceptance criteria, sizing or estimating it, asking the clarifying
    questions that shape the work.
  - `ready` - definition is settled and the item is waiting to be picked up.
  - `in_progress` - writing code, tests, or migrations for the item.
  - `in_review` - a PR is open and awaiting review. Record the PR on the item
    with `link_github` at the same time.
  - `done` - the PR is merged and the work is deployed or otherwise complete.
- **Do not run ahead of reality.** Only mark `done` once the change has actually
  landed, and only mark `in_review` once a PR really exists. If work stalls or
  is handed back, move the item backwards rather than leaving it parked at an
  optimistic stage.
- **When work does not map to an existing item, say so** rather than silently
  inventing status changes. Offer to create the item (`create_item` works at any
  level, including the leaf) so the work is tracked and rolls up.

## Deployment and infrastructure

- **Hosting is Fly.io, data is Fly Postgres, auth is Better Auth.** There is no
  Supabase in this project (an early plan considered it; the app moved to
  Fly.io + Better Auth before any real auth shipped). Do not add Supabase
  clients, dependencies, or migration paths.
- **Two Fly apps, two configs, in the repo root:**
  - `fly.toml` - production. Fly app `specboard`, served at
    https://app.specboards.ai.
  - `fly.test.toml` - test/staging. Fly app `specboard-test`, served at
    https://test.specboards.ai.
- **Deploy with `pnpm deploy:test` / `pnpm deploy:prod`, never a bare
  `fly deploy`.** Both wrap `scripts/deploy.sh`, which passes the running commit
  as the `GIT_SHA` build arg. That arg is what pins /legal's "Source code" link
  to the exact source running, satisfying the AGPL section 13 offer; a bare
  `fly deploy` bakes in nothing and the link silently falls back to the repo
  root. The script also refuses to ship production from a feature branch or a
  dirty tree, so the sha it bakes in always names fetchable source.
- **Always deploy to test first.** New code goes to `specboard-test` and is
  verified there before production. Never deploy production from a feature
  branch: merge to `main` first, then `pnpm deploy:prod`.
- **Merging to `main` deploys test automatically.** `.github/workflows/fly-deploy.yml`
  runs on every push to `main`, so a merged PR is on `specboard-test` within
  minutes without anyone running a command (it passes `GIT_SHA` too). Production
  is the manual step (`pnpm deploy:prod`, or the workflow's `workflow_dispatch`
  with environment `production`). Plan for this: by the time you go to verify
  something on test, it is usually already deployed.
- **Databases are Fly Postgres apps:** `specboard-test-db` (test) and
  `specboard-prod-db` (production). The app reads its connection string from the
  `DATABASE_URL` secret.
- **Schema migrations run themselves on deploy.** Both `fly.toml` and
  `fly.test.toml` set `[deploy] release_command = "node migrate.mjs"`, so Fly
  applies pending migrations in a one-off machine on the new image before it
  takes traffic, and aborts the release if that fails (the previous version
  keeps serving). Just write the migration, merge, and deploy: do not apply
  schema changes by hand. The runner is `packages/db/src/migrate.ts`, bundled
  into the image by `infra/web.Dockerfile` alongside `infra/migrations`. It is
  idempotent and takes a session advisory lock, so a retried deploy is safe. It
  uses `DATABASE_URL` (which must have DDL rights) unless `MIGRATE_DATABASE_URL`
  is set.
- **To inspect or repair a cloud database by hand**, fetch its connection string
  (`fly ssh console -a <app> -C 'printenv DATABASE_URL'`), tunnel with
  `fly proxy <local>:5432 -a <db-app>`, and point `psql` (or, in a genuine
  recovery, `pnpm db:migrate`) at the local port. This is the exception now, not
  the release path.

## Design system

- **Gesso** is our design system, maintained in Claude Design. It is the source
  of truth for brand, color, type, spacing, and component styling (the app's
  brand mark and icons are generated from it). Keep new UI consistent with
  Gesso, and reach for `/design-sync` to reconcile the app with it. The
  code-side primitives that implement these styles live in
  `apps/web/src/components/ui/` (Button, Card, Input, Select, and so on); build
  new shared components from those rather than one-off markup.

## UX conventions

- **"Add" starts as an affordance, not an open form.** Any experience for adding
  a new item (a team member, a product group, a custom card property, a repo
  link, and so on) begins as a single "Add X" control. The input fields appear
  only after the user opts in by clicking it; they expand in place (or in a
  drawer/dialog), collect the details, and collapse back to the "Add X"
  affordance after a successful save. Always offer a Cancel that collapses
  without saving. Do not leave empty input fields sitting open by default: a
  blank always-on form reads as unfinished and adds visual noise for the common
  case where the user is not adding anything right now.
- **Reveal organizing features only once there's something to organize.** A
  feature whose only job is to group or arrange other items (e.g. product
  groups) should stay hidden until there are enough items to make it useful,
  then appear. Keep it visible once it holds data so existing configuration
  never becomes unreachable.

## Writing style

- **Never use em dashes (`—`).** This applies everywhere: code comments, docs,
  Markdown, UI copy, commit messages, and PR descriptions. Rewrite the sentence
  instead, using a comma, colon, parentheses, or a hyphen (`-`) as appropriate.
  En dashes (`–`) are also out for prose; use a hyphen.
