# Runbook — GitHub App + spec sync

How to connect a repository so SpecBoard imports its `specs/**/spec.md` and keeps
the board in sync on every push. One GitHub App per environment (test, prod);
the steps are identical, just swap the host.

| Env | App host | Webhook URL |
| --- | --- | --- |
| test | `https://test.specboard.ai` | `https://test.specboard.ai/api/webhooks/github` |
| prod | `https://specboard.ai` | `https://specboard.ai/api/webhooks/github` |

The recommended path is the **in-app one-click setup** (no GitHub form-filling,
no secrets to copy). The manual env-based path is kept as an appendix for
air-gapped or scripted setups.

## Prerequisites

- `DATABASE_URL` and `BETTER_AUTH_SECRET` are set (already true wherever auth
  works). `BETTER_AUTH_SECRET` also encrypts the stored App credentials.
- The DB migrations are applied (the `github_app` table — migration `0003`).
  Migrations don't run automatically on deploy; apply with
  `DATABASE_URL=<the deployment's db> pnpm db:migrate` from the repo root.

## 1. Create the GitHub App (one click)

Sign in as a workspace **admin**, open **Repositories**, and under "Connect
SpecBoard to GitHub" optionally enter your **GitHub organization** (e.g.
`StudioPalouse`; leave blank for a personal account), then **Set up GitHub App**.

SpecBoard sends you to GitHub with the App pre-defined (name, permissions —
Contents R/W, Pull requests R/W, Metadata RO — webhook, Push event, and the
post-install Setup URL). Review and **Create GitHub App**. GitHub redirects you
back and SpecBoard stores the App's id, slug, private key, and webhook secret —
**encrypted in the database**. No `.pem` download, no secrets to paste.

## 2. Install it + connect repositories (one click)

Back on the Repositories page, click **Connect GitHub**. Pick the repos to grant
access to and install. GitHub redirects you back to a **picker** listing those
repos, each with a **Connect** button. Clicking **Connect** runs the initial
import and shows the sync summary; connected repos get a **Re-sync** button.
Nothing to copy by hand.

## 3. Verify

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
  row — connect it again from the Repositories page (owner/name are case-sensitive).
- **`sync` returns `{ error: "GitHub App is not configured" }`:** no credentials
  stored and no env vars — re-run the one-click setup (step 1).
- **"Set up GitHub App" errors:** check `BETTER_AUTH_SECRET` is set and migration
  `0003` is applied (the `github_app` table must exist).
- **Delivery ignored (202):** push was to a non-default branch, or nothing under
  the spec globs changed — both are expected no-ops.

## Appendix — manual env-based setup (alternative)

For air-gapped or scripted deployments you can skip the in-app flow and provide
credentials via env. Create the App by hand (GitHub → Settings → Developer
settings → **New GitHub App**) with: Homepage = app host; **Setup URL** =
`<host>/api/v1/github/setup` (tick *Redirect on update*); Webhook URL =
`<host>/api/webhooks/github` + a generated secret; permissions Contents R/W,
Pull requests R/W, Metadata RO; subscribe to **Push**. Generate a private key
and note the App ID and slug. Then set the secrets:

```sh
fly secrets set -a specboard-test \
  GITHUB_APP_ID=123456 \
  GITHUB_WEBHOOK_SECRET=<hex> \
  GITHUB_APP_PRIVATE_KEY="$(cat ~/Downloads/app.private-key.pem)" \
  NEXT_PUBLIC_GITHUB_APP_SLUG=<app-slug>
```

Stored (in-app) credentials take precedence over these env vars when both exist.
Repositories can also be registered via the API instead of the picker:

```sh
curl -X POST https://test.specboard.ai/api/v1/repositories \
  -H 'content-type: application/json' \
  -H 'cookie: better-auth.session_token=<your-session-token>' \
  -d '{ "installationId": "<INSTALLATION_ID>", "owner": "StudioPalouse", "name": "SpecBoard" }'
```

(or the **Advanced: connect by installation ID** form on the Repositories page).
