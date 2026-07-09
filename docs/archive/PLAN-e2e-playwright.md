# Plan: Playwright E2E, starting with the onboarding spec flow

Status: proposed (needs Jon's sign-off on the two decisions in "Open decisions").
Follows the tracer-bullet rule: stand up the smallest real end-to-end test
first, prove it green in CI, then widen coverage.

## Why now

We just shipped the onboarding spec flow (v0.1.4), and it is the freshest
untested surface. Today the repo has **zero** end-to-end tests, only unit tests
in `packages/core` and `packages/git`, and **no test job runs in CI at all**.
The whole `apps/web` layer (API routes, auth, tenancy, GitHub sync, onboarding)
is verified only by hand on `test.specboard.ai`. This plan closes that gap for
the highest-value path first and lays the harness the rest can grow on.

## Scope of the first slice

One Playwright project in `apps/web` that boots the real Next.js app against a
real Postgres, with GitHub faked, and drives the three onboarding paths we just
built:

1. A connected repo **with** `specs/**/spec.md`: scan -> confirm -> import ->
   cards appear -> board link works.
2. A connected repo **with no specs**: guided "create your first spec" ->
   starter `specs/<feature>/spec.md` is committed (against the fake) and imported
   -> a real card appears.
3. The **"Prefer a dedicated repo just for specs?"** nudge renders in both the
   empty connect section and the empty-specs state, with the prefilled
   `github.com/new?name=specs` link.

Out of scope for this slice (later slices below): RLS/tenant isolation, webhook
sync, and the real GitHub App install handshake.

## The three architectural problems, and how we solve them

### 1. Authentication (no test bypass exists)

`better-auth` uses email+password with `requireEmailVerification: true`, so a
freshly signed-up user cannot sign in until a Postmark link is clicked. There is
no shipped test shortcut, and forging a signed session cookie is brittle.

**Approach:** add one env-guarded relaxation in `apps/web/src/lib/auth.ts`: when
`SPECBOARD_E2E === "true"`, set `requireEmailVerification: false` (and skip the
Postmark send). Playwright's global setup then drives the *real* flow: sign up a
fresh user, visit `/setup` (first user in a single-tenant deployment becomes the
workspace `admin`), and save the resulting real session cookie to Playwright
`storageState`. Every test reuses that state. No cookie forgery, real auth code
path, one small guarded change.

Keep `SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS` off and Postmark unset in the test
env.

### 2. Faking GitHub (server-to-server, so page.route can't help)

Every GitHub call goes through Octokit in `packages/git/src/github.ts`. These are
server-side, so Playwright cannot intercept them from the browser. Good news:
`GitHubRepoClient` already implements the small `GitRepoClient` interface
(`listSpecFiles`, `readFile`, `writeFile`, `getPullRequest`, `getIssue`,
`getBranch`) and `reconcileSpecs` is written entirely against that interface. The
only gap is that `github-sync.ts` constructs the concrete client directly, with
no swap point.

**Approach:** introduce a narrow, env-guarded seam. Replace the direct
`createGitHubRepoClient(...)` / `getGithubApp()` calls in `github-sync.ts` (and
the scan/import/starter-spec routes) with a single resolver, e.g.
`resolveRepoClient(repo)`. In normal operation it behaves exactly as today. When
`SPECBOARD_E2E === "true"` it returns an **in-memory fake `GitRepoClient`** seeded
from a fixture (a map of repo -> spec files), and treats GitHub as "configured"
so the routes do not short-circuit on the missing App. The fake's `writeFile`
records commits in memory so the starter-spec path can assert what was written
and a follow-up scan sees the new file. Prod behavior is untouched when the flag
is off.

This is a real (small) code change to `apps/web`, not just test files. It is the
only way to get a deterministic, hermetic onboarding test without a live GitHub
App and throwaway repo.

### 3. Database and app boot

Reuse the existing local Postgres (`pnpm db:up` -> docker compose, `pnpm
db:migrate`). Point the test run at a dedicated database (e.g.
`specboard_e2e`) via `DATABASE_URL` so it never touches dev data. Playwright's
`webServer` builds and starts the app (`next build && next start`, or `next dev`
for the first cut) with the E2E env set. A `global-setup` truncates app tables
and runs the signup+setup seed; `global-teardown` is optional (truncate).

RLS is bypassed by the owner connection we already use, so the test connection
needs no special role for this slice.

## Files this slice adds or touches

Adds:
- `apps/web/playwright.config.ts` - one chromium project, `webServer`,
  `globalSetup`, `storageState`.
- `apps/web/e2e/` - `global-setup.ts` (seed admin + session), fixtures
  (`fixtures/github.ts` = the in-memory spec map), and the specs:
  `onboarding-import.spec.ts`, `onboarding-first-spec.spec.ts`,
  `onboarding-nudge.spec.ts`.
- `apps/web` devDeps: `@playwright/test`.
- `test:e2e` script in `apps/web/package.json`; a matching turbo task.

Touches (env-guarded, no prod behavior change when `SPECBOARD_E2E` unset):
- `apps/web/src/lib/auth.ts` - verification gate off in E2E.
- `apps/web/src/lib/github-sync.ts` (+ the three repositories routes) - the
  `resolveRepoClient` seam and "configured" gate.

## CI

There is no test job in CI today. Add a `test` job to `.github/workflows` (or a
new `ci.yml`) that: spins up a Postgres service, runs `pnpm db:migrate`, installs
Playwright browsers, and runs `pnpm --filter @specboard/web test:e2e`. Run it on
PRs to `main`. As a fast follow, also wire the existing unit tests
(`pnpm -w test`) into the same job so green-before-merge is actually enforced by
CI, not just by hand.

## Decisions (settled)

1. **GitHub strategy: in-memory fake.** Add the small env-guarded
   `resolveRepoClient` seam; E2E mode returns a fake `GitRepoClient` from a
   fixture. Hermetic and fast; the seam is reviewed so it can never engage in
   prod.
2. **Dev server mode: `next build && next start`.** Closer to prod and stable for
   CI. (A local env toggle for `next dev` can come later if iteration needs it.)

## Rollout (slice order)

1. DONE. Landed the two env-guarded seams (`isE2E` in `auth.ts`,
   `resolveRepoClient` + `github-e2e.ts` fake, `isGithubConfigured`/slug), flag
   off by default; prod paths unchanged (build/typecheck/test green).
2. DONE. Added Playwright + `playwright.config.ts` + `e2e/global-setup.ts`
   (real sign-up -> sign-in -> setup -> admin, saved storageState); path #1
   (scan+import) green locally.
3. DONE. Added paths #2 (guided first spec) and #3 (spec-repo nudge). All three
   green (`pnpm --filter @specboard/web test:e2e`).
4. DONE. Added `.github/workflows/ci.yml` (Postgres service -> build ->
   typecheck -> unit tests -> migrate -> Playwright). Still to do: mark the
   `test` check required on `main` in branch protection (repo admin setting).
5. Later slices (not started): webhook sync E2E, RLS/tenant isolation (needs the
   non-owner `specboard_app` role), and the real GitHub App install handshake.

### Running it locally

Needs a Postgres. Then, from the repo root:

```
createdb specboard_e2e   # once
DATABASE_URL=postgres://postgres:postgres@localhost:5432/specboard_e2e \
  pnpm --filter @specboard/db migrate
pnpm -w build
pnpm --filter @specboard/web exec playwright install chromium   # once
DATABASE_URL=postgres://postgres:postgres@localhost:5432/specboard_e2e \
  pnpm --filter @specboard/web test:e2e
```

## Risks / notes

- The GitHub seam touches shipping code. It is env-guarded and defaulted off, but
  it must be reviewed so the fake can never engage in prod. Consider asserting
  `SPECBOARD_E2E !== "true"` in production boot as a guard.
- better-auth cookie handling: we deliberately avoid forging cookies by using the
  real signup+signin path, which insulates us from internal cookie-signing
  details.
- Keep the E2E database name distinct from dev to avoid clobbering local data.
