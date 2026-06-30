# Versioning

SpecBoard ships from a single monorepo and carries **one version number** for
the whole product. Every workspace package (`specboard`, `@specboard/web`,
`@specboard/cli`, `@specboard/db`, `@specboard/core`, `@specboard/git`,
`@specboard/ui`, `@specboard/mcp`) moves in lockstep: they always share the same
`version` field. The CLI reports it via `specboard --version`.

## Scheme

We follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

While we are pre-1.0 (`0.x.y`):

- **PATCH** (`0.1.2` -> `0.1.3`): bug fixes, infra/config fixes, docs, and other
  changes that do not add user-facing capability. The trailing-space GitHub
  setup fix is a patch.
- **MINOR** (`0.1.x` -> `0.2.0`): new user-facing features or a
  backwards-incompatible change (pre-1.0 we allow breaking changes in a minor,
  but call them out in the changelog).
- **MAJOR** stays `0` until the product is declared stable.

## The increment rule (do this for every production release)

Production deploys are deliberate (`workflow_dispatch` -> `production`), so each
one gets its own version. Before shipping to `app.specboard.ai`:

1. **Pick the bump.** Fix-only since the last release -> patch. New feature ->
   minor. (When in doubt, patch.)
2. **Bump every package in lockstep.** Set the same new version in all eight
   `package.json` files (root + `packages/*` + `apps/*`). One value, everywhere.
3. **Update `CHANGELOG.md`.** Add a dated section for the new version describing
   what changed, grouped under Added / Changed / Fixed.
4. **Verify green.** `pnpm -w build`, `pnpm -w typecheck`, `pnpm -w test` must
   all pass before the branch is pushed.
5. **Merge to `main`.** This auto-deploys to test (`test.specboard.ai`). Smoke
   test there.
6. **Tag the release** on the merged `main` commit and push the tag:
   `git tag -a v0.1.3 -m "v0.1.3" && git push origin v0.1.3`.
7. **Deploy production.** Run the Fly Deploy workflow with
   `environment = production` (or `flyctl deploy` against `fly.toml`).

Keep the tag, the `CHANGELOG.md` heading, and the `package.json` version
identical for a given release.
