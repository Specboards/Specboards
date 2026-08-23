# Versioning

Specboards ships from a single monorepo and carries **one version number** for
the whole product. Every workspace package (`specboards`, `@specboards/web`,
`@specboards/cli`, `@specboards/db`, `@specboards/core`, `@specboards/git`,
`@specboards/ui`, `@specboards/mcp`) moves in lockstep: they always share the same
`version` field. The CLI reports it via `specboards --version`.

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
one gets its own version. Before shipping to `app.specboards.ai`:

1. **Pick the bump.** Fix-only since the last release -> patch. New feature ->
   minor. (When in doubt, patch.)
2. **Bump every package in lockstep, and scaffold the changelog:**
   `pnpm release:prepare 0.1.3`. This sets the same version in all eight
   `package.json` files (root + `packages/*` + `apps/*`) and inserts a dated
   `CHANGELOG.md` section. It stops there: it does not commit, tag or push.
3. **Write the `CHANGELOG.md` section** the previous step scaffolded, grouped
   under Added / Changed / Fixed. Describe what shipped, not what changed in git.
4. **Verify green.** `pnpm -w build`, `pnpm -w typecheck`, `pnpm -w test` must
   all pass before the branch is pushed.
5. **Merge to `main`.** This auto-deploys to test (`test.specboards.ai`). Smoke
   test there.
6. **Tag the release** on the merged `main` commit and push the tag:
   `git tag -a v0.1.3 -m "v0.1.3" && git push origin v0.1.3`.
7. **Deploy production.** Run the Fly Deploy workflow with
   `environment = production` (or `pnpm deploy:prod`).

Keep the tag, the `CHANGELOG.md` heading, and the `package.json` version
identical for a given release.

## This is enforced, not trusted

The list above is not new, and it was skipped eight times: 0.22.0 through 0.25.2
went out with the repo reading `0.21.0`, and 0.27.0 and 0.27.2 went out with it
reading `0.26.8`. See the gap notice in [CHANGELOG.md](./CHANGELOG.md).

So step 7 now checks steps 2, 3 and 6 actually happened.
`scripts/release-guard.sh` refuses a production deploy unless:

- every workspace package carries the same version;
- `CHANGELOG.md` has a section for it;
- a tag `vX.Y.Z` points at **the commit being deployed** (not merely somewhere
  in history, which an old tag would satisfy).

It runs on both routes to production, so neither is weaker than the other: from
`scripts/deploy.sh` for a local `pnpm deploy:prod`, and as a step in the
`deploy-production` job of `.github/workflows/fly-deploy.yml`. Test deploys are
deliberately exempt: test exists to look at work in progress, most of which will
never carry a version.

Run `pnpm release:check` any time to see where a release currently stands.

## Publishing the CLI to npm

`@specboards/cli` shares the single monorepo version but publishes to npm on its
own trigger: pushing a `cli-v<version>` tag (e.g. `cli-v0.21.0`) runs
`.github/workflows/cli-release.yml`, which verifies the tag matches
`apps/cli/package.json`, builds, tests, and `pnpm publish`es. Publishing is
therefore decoupled from a production deploy - tag `cli-v*` only when you want a
new npm release of the CLI, using the same version number as the rest of the
monorepo. See `packaging/homebrew/README.md` for the matching Homebrew step.
