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

- **Name:** `SpecBoard (Test)` (must be globally unique).
- **Homepage URL:** the app host above.
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

App page → **Install App** → choose the account → select the repository (e.g.
`StudioPalouse/SpecBoard`). After installing, the URL is
`…/settings/installations/<INSTALLATION_ID>` — note `<INSTALLATION_ID>`.

## 3. Set the Fly secrets

```sh
fly secrets set -a specboard-test \
  GITHUB_APP_ID=123456 \
  GITHUB_WEBHOOK_SECRET=<hex-from-step-1> \
  GITHUB_APP_PRIVATE_KEY="$(cat ~/Downloads/specboard-test.private-key.pem)"
```

`GITHUB_APP_PRIVATE_KEY` accepts either a real multi-line PEM (as above) or a
single line with literal `\n` escapes — the app unfolds them at load. Setting
secrets triggers a redeploy.

## 4. Register the repository

No management UI yet — register through the API as a workspace **admin**. The
endpoint needs your session cookie; grab it from the browser devtools
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
