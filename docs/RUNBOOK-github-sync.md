# Runbook — GitHub App + spec sync

How to connect a repository so SpecBoard imports its `specs/**/spec.md` and keeps
the board in sync on every push. One GitHub App per environment (test, prod);
the steps are identical, just swap the host.

| Env | App host | Webhook URL |
| --- | --- | --- |
| test | `https://test.specboard.ai` | `https://test.specboard.ai/api/webhooks/github` |
| prod | `https://specboard.ai` | `https://specboard.ai/api/webhooks/github` |

## 1. Create the GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**.

- **Name:** `SpecBoard (Test)` (must be globally unique). The slug GitHub
  derives (e.g. `specboard-test`) is what `NEXT_PUBLIC_GITHUB_APP_SLUG` must be
  set to — it powers the in-app "Connect GitHub" button.
- **Homepage URL:** the app host above.
- **Setup URL (post-installation):** `<app host>/api/v1/github/setup`, and tick
  **Redirect on update**. This is the frictionless flow: after a user installs
  the App and picks repos, GitHub redirects them back here and the Repositories
  page lists the granted repos to connect with one click (no copying ids).
- **Webhook → Active:** on. **URL:** the webhook URL above.
- **Webhook secret:** generate one and keep it — `openssl rand -hex 32`. This is
  `GITHUB_WEBHOOK_SECRET`.
- **Repository permissions:**
  - **Contents:** Read & write _(write is required — SpecBoard commits a stable
    `id` into each spec's frontmatter on first import, and writes spec edits back)._
  - **Pull requests:** Read & write _(for `writeMode: pr`)._
  - **Metadata:** Read-only (mandatory default).
- **Subscribe to events:** **Push**.
- **Where can this app be installed:** Only on this account.
- Create, then **Generate a private key** — downloads a `.pem`. This is
  `GITHUB_APP_PRIVATE_KEY`.
- Note the **App ID** near the top — this is `GITHUB_APP_ID`.

## 2. Install it on the repo

Once the secrets in step 3 are set, the easiest path is **from the app**: sign
in as an admin, open **Repositories**, and click **Connect GitHub** — that sends
you to the App's install page, and GitHub brings you back to the picker (see
step 4). You can also install directly: App page → **Install App** → choose the
account → select the repository (e.g. `StudioPalouse/SpecBoard`). Either way,
after installing the URL is `…/settings/installations/<INSTALLATION_ID>` — note
`<INSTALLATION_ID>` only if you plan to use the manual fallback.

## 3. Set the Fly secrets

```sh
fly secrets set -a specboard-test \
  GITHUB_APP_ID=123456 \
  GITHUB_WEBHOOK_SECRET=<hex-from-step-1> \
  GITHUB_APP_PRIVATE_KEY="$(cat ~/Downloads/specboard-test.private-key.pem)" \
  NEXT_PUBLIC_GITHUB_APP_SLUG=specboard-test
```

`NEXT_PUBLIC_GITHUB_APP_SLUG` is the App's slug; it's read server-side at
runtime (to build the "Connect GitHub" link), so a secret set is enough — no
rebuild needed.

`GITHUB_APP_PRIVATE_KEY` accepts either a real multi-line PEM (as above) or a
single line with literal `\n` escapes — the app unfolds them at load. Setting
secrets triggers a redeploy.

## 4. Register the repository

**One-click flow (recommended):** sign in as a workspace **admin**, open
**Repositories** (top nav, or "Connect a repository" on an empty board), and
click **Connect GitHub**. Install the App on the repos you want; GitHub redirects
you back and the page lists those repos with a **Connect** button each. Clicking
**Connect** runs the initial import and shows the sync summary; connected repos
get a **Re-sync** button. Nothing to copy by hand.

> Requires `NEXT_PUBLIC_GITHUB_APP_SLUG` (step 3) and the **Setup URL** on the
> App (step 1). Without them, fall back to manual entry below.

**Manual fallback (UI):** on the Repositories page, expand **Advanced: connect
by installation ID** and enter the owner, repository name, and `<INSTALLATION_ID>`
from step 2, then **Connect**.

**From the API (alternative):** register through the endpoint as a workspace
**admin**. It needs your session cookie; grab it from the browser devtools
(Application → Cookies → `better-auth.session_token`) while signed in.

```sh
curl -X POST https://test.specboard.ai/api/v1/repositories \
  -H 'content-type: application/json' \
  -H 'cookie: better-auth.session_token=<your-session-token>' \
  -d '{
    "installationId": "<INSTALLATION_ID>",
    "owner": "StudioPalouse",
    "name": "SpecBoard"
  }'
```

The response includes the created `repository` and a `sync` summary
(`{ upserted, skipped, idsInjected }`) from the initial import. `defaultBranch`
defaults to `main`; pass it if specs live on another branch. Glob/field config is
read from the repo's `.specboard/config.yml` on each sync — no need to send it.

## 5. Verify

- **Initial import:** the `sync` summary above should show `upserted > 0`; the
  board now lists the repo's specs.
- **Stable ids:** specs that lacked an `id` get a `chore(specboard): assign
  stable id …` commit on `main`.
- **Live sync:** push a change to any `specs/**/spec.md`; GitHub App → Advanced →
  **Recent Deliveries** should show the push delivery returning **200**, and the
  board reflects the change.

## Troubleshooting

- **Delivery 401 (Invalid signature):** `GITHUB_WEBHOOK_SECRET` doesn't match the
  App's webhook secret.
- **Delivery 404 (not connected):** the push's `owner/name` has no `repositories`
  row — re-run step 4 (owner/name are case-sensitive).
- **`sync` returns `{ error: "GitHub App is not configured" }`:** `GITHUB_APP_ID`
  / `GITHUB_APP_PRIVATE_KEY` aren't set on the app.
- **Delivery ignored (202):** push was to a non-default branch, or nothing under
  the spec globs changed — both are expected no-ops.
