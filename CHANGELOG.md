# Changelog

All notable changes to Specboard are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). See [VERSIONING.md](./VERSIONING.md)
for how and when the version is bumped.

## [0.2.1] - 2026-07-03

### Changed

- Dark mode now carries a deep blue tint instead of neutral gray, aligning
  the theme with the Specboard brand. Surface lightness is unchanged, so
  contrast is unaffected.

## [0.2.0] - 2026-07-03

### Added

- One-click dedicated spec repo creation during onboarding: for organization
  installations, Specboard creates a private repo, connects it, and hands off
  to the first-spec walkthrough to seed it. Requires the GitHub App's
  repository Administration (write) permission; the self-host manifest now
  requests it, and hosted Apps need it added in GitHub. Personal-account
  installations keep the manual deep-link steps.
- The connect picker's repository list is prefetched server-side, so it
  renders with the initial HTML instead of popping in after a client fetch;
  loading states now use skeletons.

### Changed

- GitHub App installations are persisted in a workspace-scoped
  `github_installations` table (migration 0019) instead of a 15-minute signed
  cookie, so the connect picker, repo creation, and repo connect work on any
  later visit. Multiple installations per workspace are supported, uninstall
  webhooks drop the binding, and stale rows self-heal on read.

### Security

- Hardened the app surface ahead of an external pen test: security headers
  (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy),
  Better Auth rate limiting with stricter credential-path rules, a non-root
  runtime container, and a CSRF nonce on the GitHub App install round-trip.
- Closed cross-tenant defense-in-depth gaps: webhooks reconcile every
  workspace that connected a repo, assignee and product-member targets are
  validated as workspace members, and changing a product's visibility is
  restricted to org admins.
- Sturdier input handling: malformed percent-escapes no longer 500 the site,
  an unparseable spec is skipped instead of aborting the repo sync, and the
  untrusted repo config's globs and statuses are bounded to limit ReDoS.
- Provisioned (not yet activated) a non-owner `specboard_app` database role
  for the row-level-security cutover.

## [0.1.6] - 2026-07-01

### Fixed

- Deployed apps served a broken logo image on the sign-in and sign-up cards:
  the Docker runtime image did not include the `public` folder, which Next.js
  standalone output requires to be copied in manually, so every public asset
  returned 404 in cloud environments.

## [0.1.5] - 2026-07-01

### Added

- App branding from the new logo kit: favicon, apple touch icon, and social
  preview (Open Graph) image, plus the icon mark in the sidebar header and on
  the sign-in and sign-up cards.
- First automated end-to-end tests: a Playwright suite covering the onboarding
  spec flow (scan and import, guided first spec, dedicated-repo nudge), run in
  CI on every pull request and now a required check on `main`.

### Changed

- Brand spelling unified to "Specboard" (previously "SpecBoard") across the UI,
  docs, and emails.
- Dependencies updated to latest compatible versions (better-auth 1.6.23,
  Tailwind 4.3.2, lucide-react 1.23, vitest 3.2, turbo 2.10, prettier 3.9).
  The vitest bump moves the transitive vite past two security advisories.

### Fixed

- Flaky end-to-end setup: signing in raced the app's own redirect to `/setup`.

## [0.1.4] - 2026-07-01

### Added

- Onboarding spec flow. Connecting a repository now registers it without
  auto-importing; an "Import your specs" panel scans connected repos read-only
  for `spec.md` files and creates cards only after you confirm, then links to the
  board.
- Guided first spec. When connected repos have no specs, the empty state walks
  you through naming a feature and picking a repo, then commits a starter
  `specs/<feature>/spec.md` (stable id and template body) and imports it so a
  real card appears. Refuses to overwrite an existing file.
- "Prefer a dedicated repo just for specs?" nudge for users without a suitable
  repo: a prefilled link to create a `specs` repo on GitHub, then install,
  connect, and seed it through the existing flow. No new GitHub App permissions.

## [0.1.3] - 2026-06-30

### Added

- CLI: `specboard --version` (also `version` / `-v`) prints the released
  version, read from the package manifest at runtime.
- `VERSIONING.md` documenting the single-version monorepo scheme and the
  per-release increment rule, plus this changelog.

### Fixed

- GitHub App install: a stray trailing space in the hand-configured "Setup URL"
  made GitHub redirect post-install to `/api/v1/github/setup%20`, a 404.
  Middleware now normalizes any trailing-whitespace variant back to the real
  route, preserving the `installation_id` / `setup_action` query, so the connect
  flow lands on the Repositories page instead of a dead end.

## [0.1.0]

- Initial baseline: spec backlog, roadmap, GitHub sync, multi-tenant org model,
  programmatic API keys, and the `specboard` CLI.
