# RUNBOOK: GitHub installation-bind takeover smoke test

Backlog card: "Smoke-test malicious install-bind path on cloud test" (Security &
platform hardening epic). This is a **manual QA** procedure to run on cloud
**test**; there is no code change here. The fix it validates already shipped.

## What already shipped (the fix under test)

The original vulnerability (P0 #1, GitHub installation-binding takeover) let a
user bind an installation of the GitHub App to *their* workspace even if they
did not own/administer the installation account, giving them sync/enumeration
over someone else's repos. The fix:

- The GitHub App **Setup URL** callback bounces through the App **authorize**
  URL first, so we obtain the acting user's GitHub identity
  (`/api/v1/github/setup` -> authorize -> `/api/v1/github/oauth/callback`).
- `/api/v1/github/oauth/callback` verifies that the authenticated GitHub
  identity **owns or administers the installation account** before binding.
- The setup transaction is bound in `github_install_states` (migration 0035):
  single-use, 15-minute expiry, tying the installation to the initiating
  session so it can't be replayed or bound by a different user.
- Unit tests + a fail-closed E2E (`e2e/github-install-security.spec.ts`) cover
  the negative path.

This runbook is the residual **manual** confirmation the card asks for: prove,
against a *second live installation* on cloud test, that a user who is **not**
an admin of the installation account cannot bind, enumerate, or sync it end to
end.

## Prerequisites

- Cloud **test** deploy is current (`test.specboards.ai`, app `specboard-test`)
  with the fix live.
- Both GitHub Apps have their client secret + callback URL configured for the
  test environment (the hosted deployment prerequisites the card notes).
- Two GitHub accounts / orgs:
  - **Account A** - owns/administers a GitHub org where the App will be
    installed (the *victim* installation account).
  - **Account B** - a Specboards user who is **not** an admin of Account A's org.
- A Specboards workspace controlled by Account B.

## The attack path to prove is blocked

1. As **Account A**, install the GitHub App on Account A's org (creates a live
   installation, `installation_id = INST_A`).
2. As **Account B**, sign in to `test.specboards.ai` and start the connect flow.
   Attempt to bind `INST_A` to Account B's workspace. Try each vector:
   - **Direct callback replay:** hit
     `/api/v1/github/oauth/callback?installation_id=INST_A&...` with values
     lifted from Account A's setup redirect (or a hand-crafted state).
   - **Setup URL forgery:** hit `/api/v1/github/setup?installation_id=INST_A&setup_action=install`
     directly while signed in as Account B.
   - **State reuse:** capture a valid `github_install_states` token from a
     legitimate Account B flow and try to submit it with `INST_A`.

### Expected (pass) at every vector

- The bind is **refused**: the callback verifies Account B is not an admin of
  the `INST_A` account and returns an error / does not create a binding.
- No `repositories` / `github_installations` row for `INST_A` is created under
  Account B's workspace.
- Account B cannot list, connect, enumerate, or sync any repo under `INST_A`.
- The state token is single-use and expires (a second submit, or one after
  15 min, is rejected).
- A security event is logged for the refused attempt (check the app logs).

### Also confirm the legitimate path still works (no false-block)

- As **Account A**, install + bind to Account A's own Specboards workspace: the
  bind succeeds, repos list, and a push reconciles specs (regression guard that
  the ownership check doesn't block legitimate installs).

## Cleanup

- Uninstall the App from Account A's org.
- Remove any test workspaces / bindings created.
- Rotate any state/token captured during testing (they are single-use, but
  tidy up).

## Done when

- Every vector above is refused for the non-admin (Account B), the legitimate
  Account A install still works, and the refusals are logged.
- The card is moved to done with a note recording the date, the test
  environment, and the two accounts used (not their credentials).
