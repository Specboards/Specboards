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

## Deployment and infrastructure

- **Hosting is Fly.io, data is Fly Postgres, auth is Better Auth.** There is no
  Supabase in this project (an early plan considered it; the app moved to
  Fly.io + Better Auth before any real auth shipped). Do not add Supabase
  clients, dependencies, or migration paths.
- **Two Fly apps, two configs, in the repo root:**
  - `fly.toml` - production. Fly app `specboard`, served at
    https://app.specboard.ai. Deploy from the repo root with `fly deploy`.
  - `fly.test.toml` - test/staging. Fly app `specboard-test`, served at
    https://test.specboard.ai. Deploy with `fly deploy -c fly.test.toml`.
- **Always deploy to test first.** New code goes to `specboard-test` and is
  verified there before production. Never deploy production from a feature
  branch: merge to `main` first, then `fly deploy`.
- **Databases are Fly Postgres apps:** `specboard-test-db` (test) and
  `specboard-prod-db` (production). The app reads its connection string from the
  `DATABASE_URL` secret. Run migrations against a cloud DB by fetching that
  secret (`fly ssh console -a <app> -C 'printenv DATABASE_URL'`), tunnelling with
  `fly proxy`, and running `pnpm db:migrate` against the local port.

## Writing style

- **Never use em dashes (`—`).** This applies everywhere: code comments, docs,
  Markdown, UI copy, commit messages, and PR descriptions. Rewrite the sentence
  instead, using a comma, colon, parentheses, or a hyphen (`-`) as appropriate.
  En dashes (`–`) are also out for prose; use a hyphen.
