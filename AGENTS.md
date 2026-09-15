# Project instructions for Codex

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

## Delivering work

- **Every chunk of work reaches `main` through a pull request.** Open one, let
  the checks run, and let a human merge it. A one-line fix included.
  `.github/workflows/ci.yml` runs on `pull_request` and on pushes to `main`,
  and only the pull-request path runs the gate before the code is on `main`
  and already deploying to test. A direct push runs the same checks a minute
  too late.
- The gate covers the Postgres integration suite and the Playwright e2e suite,
  neither of which runs without Docker. Passing typecheck, lint and unit tests
  locally is a weaker claim than it sounds, especially for anything touching a
  migration, row-level security, a transaction boundary, or notifications.
- Open the pull request as a draft while the work is still landing. Agents open
  pull requests and do not merge them.

## Writing style

- **Never use em dashes (`—`).** This applies everywhere: code comments, docs,
  Markdown, UI copy, commit messages, and PR descriptions. Rewrite the sentence
  instead, using a comma, colon, parentheses, or a hyphen (`-`) as appropriate.
  En dashes (`–`) are also out for prose; use a hyphen.
