# Plan — Move the repo to the `Specboards` GitHub org

- **Status:** Ready to execute
- **Scope:** Transfer `StudioPalouse/Specboard` → `Specboards/SpecBoard`, fix
  everything that references the old org, and register the hosted GitHub Apps
  under `Specboards`.
- **You do:** the actual repo transfer (GitHub UI). **This doc:** every update
  needed afterward + the prod App registration.

> Why `Specboards` (with the "s"): the bare name **`Specboard` is permanently
> reserved** to a foreign `@Specboard` GitHub org (created 2025-03-19, not one we
> belong to). Verified via the API — there is no path to claim it. `Specboards`
> is the org we control; `specboards` is free as an App slug.

---

## 0. What a GitHub repo transfer does and does NOT carry over

**Carries automatically:** code, branches, tags, issues, PRs, milestones,
labels, releases, stars/watchers, and **URL redirects** (old
`StudioPalouse/Specboard` links and `git remote` keep working via redirect).

**Does NOT carry — must be redone in the new location:**
- **Actions secrets & variables** (incl. `FLY_API_TOKEN_TEST` /
  `FLY_API_TOKEN_PROD` / `FLY_API_TOKEN_MARKETING`) — deploys break until re-added.
- **Branch protection rules / rulesets.**
- **GitHub App installations** — the test App (`specboard-studiopalouse`, owned by
  StudioPalouse) currently has access to the repo *because the repo is in
  StudioPalouse*. After the move it no longer does; the repo must be re-connected
  via an App installed on `Specboards` (see §4).
- Repo-level **collaborator/team** access (org teams differ).

---

## 1. Pre-move checklist

- [ ] Confirm you're an **owner** of the `Specboards` org (needed to accept the
      transfer and create Apps).
- [ ] Have the deploy tokens handy to re-add as secrets (Fly):
      `fly tokens create deploy -a specboard-test`,
      `fly tokens create deploy -a specboard`,
      `fly tokens create deploy -a specboard-marketing`
      (or reuse the existing token values if you still have them).
- [ ] Note the current test repo connection (for restoring it):
      owner `StudioPalouse`, name `Specboard`, branch `main`,
      installation_id `140279350`, workspace `palouse`.
- [ ] Merge or note any open PRs/branches (they survive the transfer, but it's
      cleaner to land in-flight work first).

---

## 2. The move (you, in GitHub UI)

1. `StudioPalouse/Specboard` → **Settings → General → Danger Zone → Transfer
   ownership** → new owner **`Specboards`**, repo name **`Specboard`**.
2. Confirm. The repo is now **`Specboards/SpecBoard`**.

---

## 3. Post-move: repo wiring

### 3a. Local git remote (each clone)
```sh
git remote set-url origin https://github.com/Specboards/SpecBoard.git
git remote -v   # verify
```
(The old URL still redirects, but update it to avoid surprises.)

### 3b. Re-add Actions secrets (CRITICAL — deploys are dead without these)
In `Specboards/SpecBoard` → **Settings → Secrets and variables → Actions**, add:
- `FLY_API_TOKEN_TEST`
- `FLY_API_TOKEN_PROD`
- `FLY_API_TOKEN_MARKETING`

Then confirm CI works: push a trivial commit to `main` (must touch a non-docs
file — the workflow ignores `docs/**` and `**.md`) and watch the **Fly Deploy →
deploy-test** job go green.

### 3c. Re-create branch protection / rulesets
Re-apply whatever `main` protection you had (required PR, status checks, etc.) —
these do not transfer.

---

## 4. Post-move: reconnect the **test** repo to GitHub sync

The test deployment syncs `Specboards/SpecBoard` once an App with access to it is
installed and the DB connection row matches the new owner. Two parts:

### 4a. Give an App access to the moved repo
Easiest path that also serves multi-tenant install (one shared test App):
1. Make the existing test App installable anywhere:
   `github.com/organizations/StudioPalouse/settings/apps/specboard-studiopalouse`
   → **Where can this GitHub App be installed? → Any account**.
2. Install it on the new repo: from that App page → **Install App** → choose
   **`Specboards`** → select `Specboards/SpecBoard`.

   *(Alternative, if you want test fully under `Specboards`: register a fresh
   test App under `Specboards` with webhook
   `https://test.specboard.ai/api/webhooks/github` and set
   `GITHUB_APP_*` / `NEXT_PUBLIC_GITHUB_APP_SLUG` on `specboard-test` — same shape
   as the prod steps in §5. Then the old `specboard-studiopalouse` can be retired.)*

### 4b. Point the DB row at the new owner + installation
Reconnecting through the app UI is cleanest: on
`test.specboard.ai/palouse/settings/repositories`, the install redirect lands on
the repo picker — **Connect** `Specboards/SpecBoard` (it upserts owner +
installation_id and re-imports). Then remove the stale `StudioPalouse/Specboard`
row if one lingers.

If you'd rather do it directly (proxy via `fly proxy 15432:5432 -a specboard-test-db`, then `psql` as `specboard_owner`):
```sql
-- new installation_id comes from the install in 4a (App → Advanced, or the
-- installation URL). Replace <NEW_INSTALL_ID>.
update repositories
   set owner = 'Specboards', github_installation_id = '<NEW_INSTALL_ID>'
 where owner = 'StudioPalouse' and name = 'Specboard';
```
Verify a push to `Specboards/SpecBoard` `main` shows a **200** delivery (App →
Advanced → Recent Deliveries) and the board reflects the change.

---

## 5. Register the **prod** shared GitHub App (under `Specboards`)

This is what unblocks the "GitHub isn't available yet" card on
`app.specboard.ai`. One App, owned by `Specboards`, installable by any account.

### 5a. Generate a webhook secret (keep it for step 5c)
```sh
openssl rand -hex 32
```

### 5b. Create the App (browser, signed in as a `Specboards` owner)
`github.com/organizations/Specboards/settings/apps` → **New GitHub App**:

| Field | Value |
| --- | --- |
| **GitHub App name** | `Specboards` (slug becomes `specboards` — confirmed free) |
| **Homepage URL** | `https://app.specboard.ai` |
| **Callback URL** | `https://app.specboard.ai/api/v1/github/app/callback` |
| **Setup URL** | `https://app.specboard.ai/api/v1/github/setup` — tick **Redirect on update** |
| **Webhook → Active** | on |
| **Webhook URL** | `https://app.specboard.ai/api/webhooks/github` |
| **Webhook secret** | the value from 5a |
| **Repository permissions** | Contents **R/W**, Pull requests **R/W**, Issues **Read**, Metadata **Read** |
| **Subscribe to events** | **Push**, **Pull request**, **Issues** |
| **Where can this be installed?** | **Any account** |

Create it, then **Generate a private key** (downloads a `.pem`). Note the
**App ID** and **slug** (`specboards`).

### 5c. Set the prod secrets (I can run this for you)
```sh
fly secrets set -a specboard \
  GITHUB_APP_ID=<app id> \
  GITHUB_WEBHOOK_SECRET=<value from 5a> \
  GITHUB_APP_PRIVATE_KEY="$(cat /path/to/specboards.<...>.private-key.pem)" \
  NEXT_PUBLIC_GITHUB_APP_SLUG=specboards
```
The machines restart; on `app.specboard.ai/nintex/settings/repositories` the
"GitHub isn't available yet" card is replaced by the normal **Connect GitHub**
install flow. (Code reads the slug/keys from env — nothing hardcodes a name.)

### 5d. Verify
- `app.specboard.ai/.../settings/repositories` shows the install button.
- Install on a repo, connect it, confirm an initial import + a 200 webhook
  delivery.

---

## 6. Post-move: code & content edits (rename references)

These don't block deploys but should land so links/branding are correct. File
references as of the move:

| File | Change |
| --- | --- |
| `apps/marketing/src/lib/site.ts:10` | `GITHUB_URL` default → `https://github.com/Specboards/SpecBoard` (or set `NEXT_PUBLIC_GITHUB_URL` at marketing build) |
| `apps/marketing/src/components/site-footer.tsx:22` | footer link text `StudioPalouse/Specboard` → `Specboards/SpecBoard` |
| `docs/RUNBOOK-marketing-site.md:55` | update the `NEXT_PUBLIC_GITHUB_URL` default note |
| `docs/RUNBOOK-github-sync.md` (~L81, L161) | example owner `StudioPalouse` → `Specboards` |
| `apps/web/src/components/repositories-manager.tsx:463` | manual-connect owner placeholder `StudioPalouse` → `Specboards` (cosmetic) |
| `docs/BACKLOG.md` | issue links `github.com/StudioPalouse/Specboard/...` — optional; old links auto-redirect |

Leave as-is (not org references): `packages/core/src/email-domains.test.ts`
(`studiopalouse.com` is just a non-consumer-domain test fixture).

**Decision needed:** is `Specboards/SpecBoard` **public**? The marketing footer
links to it publicly. If the repo stays private, either point the link at a
public mirror or drop it — otherwise visitors hit a 404.

After editing, redeploy:
- web → push to `main` (auto test) then dispatch prod (`workflow_dispatch`
  environment=production).
- marketing → dispatch (`workflow_dispatch` environment=marketing) or push a
  change under `apps/marketing/**`.

---

## 7. Final verification checklist

- [ ] CI deploy-test green from the new repo.
- [ ] Prod deploy green (manual dispatch).
- [ ] `test.specboard.ai` syncs `Specboards/SpecBoard` (200 delivery).
- [ ] `app.specboard.ai` Repositories page shows the install flow (App from §5).
- [ ] Marketing footer / GitHub links resolve.
- [ ] Branch protection re-applied on `main`.

---

## 8. Notes / rollback

- The transfer is reversible (transfer back to `StudioPalouse`), and old URLs
  redirect both ways during the grace period — but **secrets, App installs, and
  branch protection must be re-set each way**, so avoid bouncing it around.
- Fly is unaffected: the Fly **org** is `specboard` and the apps
  (`specboard-test`, `specboard`, `specboard-marketing`) are unchanged — only the
  Actions tokens that *call* Fly need re-adding (§3b).
- The webhook URLs never change (they point at the app hosts), so only the App
  *ownership/installation* and the DB `repositories.owner` move.
