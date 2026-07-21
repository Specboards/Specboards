# Runbook: GitHub App + spec sync

How to connect a repository so Specboards imports its `specs/**/spec.md` and keeps
the board in sync on every push.

## Two deployment models: pick the right one

A GitHub App registration hard-codes one webhook URL and one OAuth callback URL,
so a single App can only ever serve one Specboards instance. That splits setup
into two paths, keyed off `SPECBOARD_MULTI_TENANT`:

| Model | Flag | GitHub App | How tenants connect |
| --- | --- | --- | --- |
| **Hosted** (test, prod) | `SPECBOARD_MULTI_TENANT=true` | One **shared** App Specboards owns under `@specboard`, configured via env | Click **Install**, never create |
| **Self-host** | unset (default) | Each install creates its **own** App via the one-click manifest flow | One-click setup, then install |

On the hosted deployment the in-app "create App" flow is **disabled**: it would
hit GitHub's reserved-name wall (`Specboards` is reserved for `@specboard`) and
overwrite the deployment-wide singleton credentials. Tenants only install the
shared App. The one-click manifest flow below is the **self-host** path.

| Env | Model | App host | Webhook URL |
| --- | --- | --- | --- |
| test | hosted | `https://test.specboard.ai` | `https://test.specboard.ai/api/webhooks/github` |
| prod | hosted | `https://app.specboard.ai` | `https://app.specboard.ai/api/webhooks/github` |

→ **Hosted setup is in [§ Hosted: one shared App](#hosted-one-shared-app).**
The rest of this runbook (steps 1–3) is the **self-host** one-click path.

## Prerequisites

- `DATABASE_URL` and `BETTER_AUTH_SECRET` are set (already true wherever auth
  works). `BETTER_AUTH_SECRET` also encrypts the stored App credentials.
- The DB migrations are applied (the `github_app` table, migration `0003`).
  Migrations don't run automatically on deploy; apply with
  `DATABASE_URL=<the deployment's db> pnpm db:migrate` from the repo root.

## Hosted: one shared App

For the hosted deployments (test, prod) you register **one** GitHub App per
environment, owned by the `Specboards` org, and provide its credentials via env.
Tenants never create an App; they only install this one. Each environment needs
its own App because a GitHub App binds to a single host's webhook/callback URLs
(test → `test.specboard.ai`, prod → `app.specboard.ai`).

1. **Register the App** under the `Specboards` org: GitHub → org **Settings** →
   Developer settings → **New GitHub App**. Set Homepage = app host; Webhook URL
   = `<host>/api/webhooks/github` + a generated secret; **Setup URL** =
   `<host>/api/v1/github/setup` (tick *Redirect on update*); Callback URL =
   `<host>/api/v1/github/app/callback`; permissions Contents R/W, Pull requests
   R/W, Issues RO, Metadata RO; subscribe to **Push**, **Pull request**, and
   **Issues**. Under **Where can this GitHub App be installed?** choose **Any
   account** so other orgs can install it. Generate a private key; note the App
   ID and slug.
2. **Set the secrets** (per env), including the multi-tenant flag so the in-app
   create flow is disabled and tenants get the Install button:

   ```sh
   fly secrets set -a specboard-test \
     SPECBOARD_MULTI_TENANT=true \
     GITHUB_APP_ID=123456 \
     GITHUB_WEBHOOK_SECRET=<hex> \
     GITHUB_APP_PRIVATE_KEY="$(cat ~/Downloads/app.private-key.pem)" \
     NEXT_PUBLIC_GITHUB_APP_SLUG=<app-slug>
   ```

3. **Tenants connect** by opening **Repositories** → **Connect GitHub**, which
   installs the shared App on their repos; the picker then lists those repos to
   connect (same as self-host step 2 below). Each install is a distinct
   `installation_id` scoped to that tenant: one App, many installations.

> Without `SPECBOARD_MULTI_TENANT=true` the deployment behaves as self-host and
> exposes the per-tenant create flow. On a shared deployment that lets one
> tenant's "create App" overwrite another's stored credentials. Always set the
> flag on hosted.

> **Stored creds override env.** `getStoredCredentials` (a row in the `github_app`
> table) takes precedence over these env vars. If a deployment was ever set up
> via the in-app create flow, that stored row keeps winning and your new env
> secrets are ignored until you delete it:
> `DELETE FROM github_app;` (singleton table). Any repos connected under the old
> App also carry stale `github_installation_id`s and must be re-installed +
> reconnected against the new App.

---

## 1. Create the GitHub App (one click): self-host

Sign in as a workspace **admin**, open **Repositories**, and under "Connect
Specboards to GitHub" optionally enter your **GitHub organization** (e.g.
`Specboards`; leave blank for a personal account), then **Set up GitHub App**.

Specboards sends you to GitHub with the App pre-defined: name; permissions
Contents R/W, Pull requests R/W, Issues RO, Metadata RO; webhook; the **Push**,
**Pull request**, and **Issues** events; and the post-install Setup URL. The
name is suffixed with your org/workspace (e.g. `Specboards (acme)`) because App
names are globally unique and the bare `Specboards` is reserved for `@specboard`.
Review and **Create GitHub App**. GitHub redirects you back and Specboards stores the
App's id, slug, private key, and webhook secret, all **encrypted in the database**.
No `.pem` download, no secrets to paste.

> **Upgrading an App created before GitHub feature linking (migration `0009`):**
> existing Apps were created subscribing to **Push only**. To get live PR/issue
> state on linked features, open the App's settings on GitHub → **Permissions &
> events**, add **Issues: Read-only**, and subscribe to the **Pull request** and
> **Issues** events. Manual linking and cached state-on-create work without this;
> only the automatic open→merged/closed refresh needs it.

## 2. Install it + connect repositories (one click)

Back on the Repositories page, click **Connect GitHub**. Pick the repos to grant
access to and install. GitHub redirects you back to a **picker** listing those
repos, each with a **Connect** button. Clicking **Connect** runs the initial
import and shows the sync summary; connected repos get a **Re-sync** button.
Nothing to copy by hand.

## 3. Verify

- **Initial import:** the `sync` summary above should show `upserted > 0`; the
  board now lists the repo's specs (as **Work Items**, the spec-backed leaf).
- **Feature grouping:** the summary's `featuresCreated` counts Feature groupings
  auto-created to home new work items. Each spec lands under a Feature chosen by a
  stable key: its `feature:` frontmatter when set, else its folder path (so specs
  in the same directory share a Feature). Sync only assigns a Feature when the work
  item has none, so re-syncs never override a parent you set in the app.
- **Stable ids:** specs that lacked an `id` get a `chore(specboard): assign
  stable id …` commit on `main`.
- **Live sync:** push a change to any `specs/**/spec.md`; GitHub App → Advanced →
  **Recent Deliveries** should show the push delivery returning **200**, and the
  board reflects the change.

## 4. Disconnecting a repository

On the Repositories page each connected repo has a **Disconnect** button (admin
only) next to **Re-sync**; it asks for an inline confirm before acting.

Disconnect **detaches, it does not delete your board.** The imported work items
stay on the board as standalone rows. The `features.repo_id` FK is `ON DELETE
set null` (migration `0016`), so removing the `repositories` row nulls their
`repo_id` rather than cascading. What *is* removed: the sync connection itself and
the repo's `feature_github_links` (PR/issue links, a `NOT NULL` FK that can't
refresh without the install). The GitHub App **installation** on GitHub is left
alone; uninstall it there separately if you also want to revoke access.

Under the hood: `DELETE /api/v1/repositories/:id` (admin-only, workspace-scoped).
Reconnecting later re-imports and re-homes items by their stable key, so a
disconnect → reconnect round-trip is non-destructive. To connect a different
GitHub org, just install the App there and connect. Repositories are listed
per-row, so multiple repos across multiple orgs coexist in one workspace.

## Troubleshooting

- **Delivery 401 (Invalid signature):** `GITHUB_WEBHOOK_SECRET` doesn't match the
  App's webhook secret.
- **Delivery 404 (not connected):** the push's `owner/name` has no `repositories`
  row. Connect it again from the Repositories page (owner/name are case-sensitive).
- **`sync` returns `{ error: "GitHub App is not configured" }`:** no credentials
  stored and no env vars. Re-run the one-click setup (step 1).
- **"Set up GitHub App" errors:** check `BETTER_AUTH_SECRET` is set and migration
  `0003` is applied (the `github_app` table must exist).
- **Delivery ignored (202):** push was to a non-default branch, or nothing under
  the spec globs changed. Both are expected no-ops.

## Appendix: manual env-based setup (alternative)

For air-gapped or scripted deployments you can skip the in-app flow and provide
credentials via env. Create the App by hand (GitHub → Settings → Developer
settings → **New GitHub App**) with: Homepage = app host; **Setup URL** =
`<host>/api/v1/github/setup` (tick *Redirect on update*); Webhook URL =
`<host>/api/webhooks/github` + a generated secret; permissions Contents R/W,
Pull requests R/W, Issues RO, Metadata RO; subscribe to **Push**, **Pull
request**, and **Issues**. Generate a private key and note the App ID and slug.
Then set the secrets:

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
  -d '{ "installationId": "<INSTALLATION_ID>", "owner": "Specboards", "name": "Specboards" }'
```

(or the **Advanced: connect by installation ID** form on the Repositories page).
