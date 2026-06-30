# Changelog

All notable changes to SpecBoard are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). See [VERSIONING.md](./VERSIONING.md)
for how and when the version is bumped.

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
