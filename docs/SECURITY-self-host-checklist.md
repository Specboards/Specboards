# Self-host security checklist

For operators running Specboards on their own infrastructure (the
`infra/docker-compose.yml` stack, or the same image on another host). Work
through this before exposing the deployment beyond `localhost`, then revisit it
whenever the topology or secrets change.

The hosted SaaS (app.specboards.ai) already has all of these applied; this list
exists so a self-host deployment reaches the same posture. Items are ordered
roughly by how much damage getting them wrong causes.

## 1. Canonical origin and HTTPS

- [ ] **Set `APP_URL` to the real public origin** (scheme + host, no trailing
      slash), e.g. `https://specboards.example.com`. It drives OAuth callbacks,
      webhook URLs, and OAuth discovery metadata.
- [ ] **Serve only over HTTPS** beyond localhost. Terminate TLS at your proxy
      (or a Fly/Cloud load balancer) and redirect plain HTTP to HTTPS.
- [ ] **Do not rely on forwarded headers for the origin.** Without `APP_URL` the
      app falls back to request headers, which a misconfigured or hostile proxy
      can spoof. Setting `APP_URL` is what makes the origin trustworthy.
- [ ] If you set `BETTER_AUTH_URL` or run in multi-tenant mode
      (`SPECBOARDS_MULTI_TENANT`), the boot-time canonical-origin guard
      (`assertCanonicalOrigin`, run from `apps/web/src/instrumentation.ts`)
      verifies the configuration on every start. Confirm you see the
      `[security] ... verified` line in the startup logs and that the process
      did not exit on boot.

## 2. Database exposure

- [ ] **Keep Postgres off the public network.** The bundled compose file maps
      the DB to `127.0.0.1:5432` only. Do not change this to `0.0.0.0:5432` or
      publish 5432 on a public interface. The web service reaches the DB over
      the compose network regardless of the host mapping; remove the mapping
      entirely if you do not need host-side `psql` / migrations.
- [ ] If the DB runs on a separate host, put it on a private network / VPC and
      restrict inbound to the app hosts only.
- [ ] **Always set `DATABASE_URL`.** Specboards refuses to start without it
      rather than falling back to its local file store, which has no accounts
      and no membership checks: every request there is authorized, including
      deleting spec files. If a boot fails with `Refusing to start: DATABASE_URL
      is not set`, fix the connection string; do not reach for the flag below.
- [ ] **Never set `SPECBOARDS_LOCAL_MODE` on a server.** It opts into that
      unauthenticated file store deliberately, for a single developer reading
      specs off a working tree. The app additionally refuses it unless the
      process binds loopback and serves a `localhost` origin, so this is a
      backstop, not the only control.

## 3. Secrets

- [ ] **Set a strong `POSTGRES_PASSWORD` before the first `up`.** Postgres bakes
      the password into the data volume on initialization, so changing it later
      means `ALTER USER` in psql, not just editing `infra/.env`. Generate one
      with `openssl rand -hex 24`.
- [ ] **Set `BETTER_AUTH_SECRET` (32+ characters, `openssl rand -hex 32`).**
      One secret keys three things: Better Auth session signing, the GitHub
      install-cookie HMAC, and AES-256-GCM encryption of secrets at rest (the
      GitHub App private key, webhook secret, and model provider API keys).
      Compose refuses to start
      without it, and the app refuses a value under 32 characters rather than
      deriving a weak key.
- [ ] Understand what rotating it costs **before** you rotate it: everyone is
      signed out, and any GitHub App credentials or model provider keys
      encrypted under the old key become undecryptable, so the GitHub
      integration and every workspace's model connection must be set up again.
      Unlike the database role passwords above, this is a migration rather than
      a config edit.
- [ ] Keep secrets in `infra/.env` (gitignored) or your platform's secret store,
      never in the compose file or committed config.
- [ ] **Rotate on a schedule and on staff offboarding:** `POSTGRES_PASSWORD` and
      the login passwords for the `specboards_app` / `specboards_worker` roles
      (below), any GitHub App webhook secret / private key, and OAuth client
      secrets. Rotating a role password is an `ALTER ROLE ... PASSWORD` plus
      updating the corresponding connection-string secret; no redeploy of the
      schema is needed.

## 4. Database roles (least privilege)

By default the app connects as the table owner, which bypasses row-level
security. Provisioning the dedicated non-owner roles turns the RLS policies into
a live backstop behind the app-code workspace filters.

- [ ] **Provision `specboards_app`** from `infra/rls-role.sql` (run once per
      database as a superuser / table owner), set a `LOGIN` password out of
      band, and point the app's primary connection at it. This is the role RLS
      actually enforces against.
- [ ] **Provision `specboards_worker`** from `infra/worker-role.sql` for the
      outbox drainer/relay and the GitHub webhook sink. It has grants on only a
      handful of tables, so a bug in the worker paths cannot reach auth,
      api_keys, members, comments, releases, ideas, and the rest.
- [ ] Point `DATABASE_URL_APP` and `DATABASE_URL_WORKER` at the two roles. When
      set, the boot-time worker-isolation guard (`assertWorkerIsolation`)
      fails closed if the worker connection can reach tables it should not.
- [ ] Full procedure: `docs/RUNBOOK-db-role-cutover.md`.

## 5. Outbound webhooks (SSRF)

- [ ] The in-code SSRF guard (`apps/web/src/lib/webhooks/ssrf.ts`) ships on by
      default: HTTPS-only, no redirects, every resolved address classified and
      any non-globally-routable target (loopback, RFC1918, link-local incl. the
      `169.254.169.254` metadata IP, CGNAT, ...) rejected, with the connection
      pinned to the pre-validated address to defeat DNS rebinding. No
      configuration is required to get this.
- [ ] **Leave `SPECBOARDS_WEBHOOK_ALLOW_PRIVATE` unset** unless you genuinely
      need webhooks delivered to private addresses on a trusted network. It
      turns the guard off wholesale: HTTPS, DNS checks, private-range checks
      and connection pinning. A single-tenant deployment that sets it logs a
      startup warning; a multi-tenant one ignores the flag and refuses to boot
      with it set, because there the URLs come from tenants.
- [ ] For defense in depth, add a **network-layer egress policy** so a future
      code path that bypasses the guard is still contained. This is
      platform-specific (it must carve out your own DB/data-plane traffic);
      see `docs/RUNBOOK-webhook-egress-policy.md` for the constraints and
      options.

## 6. Model provider (bring your own model)

Only relevant once a workspace connects its own inference. Full detail in
`docs/RUNBOOK-model-provider-credentials.md`; setup, air-gapped operation and
private TLS in `docs/GUIDE-self-hosted-model.md`.

- [ ] Know that the provider API key is encrypted at rest under
      `BETTER_AUTH_SECRET`, like the GitHub credentials above, so rotating that
      secret makes every stored provider key undecryptable and each workspace
      must paste its key again.
- [ ] **Set `SPECBOARDS_MODEL_ALLOW_PRIVATE=1` only if** your inference runs on
      a private address inside your own network, which is the normal on-prem
      case. It permits private/loopback targets and plain http for the model
      endpoint, and drops connection pinning for it. A multi-tenant deployment
      refuses to boot with it set.
- [ ] Leave it unset otherwise: the model endpoint is then held to the same
      HTTPS-only, globally-routable, pinned-connection policy as webhooks.
- [ ] If your endpoint presents a certificate from an internal authority or a
      self-signed one, set **`SPECBOARDS_MODEL_CA_CERT`** (PEM text or a path to
      a PEM file) rather than `NODE_TLS_REJECT_UNAUTHORIZED=0`. The former adds
      trust for the model endpoint only; the latter disables certificate
      verification for webhooks, GitHub and outbound email as well.
- [ ] Do not reach for `SPECBOARDS_WEBHOOK_ALLOW_PRIVATE` to solve a model
      problem. They are separate flags so that allowing a local model does not
      also re-point webhook deliveries at your internal network.
- [ ] Tell workspace owners that disconnecting a model destroys our copy of the
      key but does **not** revoke it at the vendor. On a suspected leak, revoke
      at the vendor first, then disconnect here.
- [ ] Know what a connected model changes about where item content goes. The
      Assistant panel on an item sends that item's title, level, status, tags,
      parent title, child titles, linked goal titles and body to the configured
      endpoint, along with the conversation so far. It sends no other item, and
      no member name or email. The panel itself lists the fields under "Show
      what is sent about this item", generated from the same data the request is
      built from rather than written by hand.
- [ ] Know that the conversation is stored (`assistant_messages`) and is
      readable by anyone who can read the item, so it inherits the item's
      product visibility rather than being private to whoever asked. Treat it as
      you treat comments.
- [ ] Grant the **`assistant`** API scope deliberately. It is separate from
      `features` for exactly this reason: it is the only scope that spends money
      outside Specboards, and `assistant:write` on a key is an unmetered
      inference channel at your provider. `assistant:read` only reads threads.
- [ ] Know that the assistant can **propose** an edit to an item's description
      and cannot apply one. A proposal is inert text inside a stored message; it
      changes nothing until a person opens the item, reads the diff, and accepts
      it. Accepting then goes through the ordinary item write path: the same
      product-write permission, the same repo write mode (so a repo in
      pull-request mode gets a pull request), the same conflict guard, and the
      same history. There is no code path from a model's output to a write.
- [ ] Understand what granting one key **both** `assistant:write` and
      `features:write` means: that key can make the assistant draft an edit and
      then accept it, with no person in between. Accepting deliberately lives at
      `POST /api/v1/features/{specId}/proposals` so the two are separate grants.
      If you want an agent that can ask but never apply, give it
      `assistant:write` and `features:read`.
- [ ] Know that **skills** (Settings, Assistant) are standing instructions sent
      with every question run under them, so their text leaves your building the
      same way an item's body does. They are edited by workspace owners only,
      and a workspace that has changed nothing stores nothing: the starting set
      ships in the code, so a fresh install has it without any seeding.
- [ ] Grant the **`assistant-skills`** API scope even more deliberately than
      `assistant`. A key with `assistant-skills:write` can rewrite what your
      assistant is told before every answer, including instructions to propose
      particular changes, and a reviewer reading the resulting diff sees only the
      change and not the reason for it. An agent that should ask questions needs
      `assistant:write` and nothing here.
- [ ] Read the git history for accepted edits if you need to tell them apart.
      They commit as `docs(spec): <name> accepted an assistant edit to <title>`,
      with the accepting person in the `Co-authored-by` trailer. The model is
      never named as an author, and the assistant never holds a git credential.

## 7. Backups

- [ ] **Take regular backups** of the Postgres volume / database (`pg_dump` or a
      volume snapshot on a schedule).
- [ ] **Encrypt backups at rest** and in transit to wherever they are stored.
      A backup is a full copy of every workspace's data; treat it with the same
      care as the live database.
- [ ] **Test a restore** periodically. An untested backup is a guess.
- [ ] Apply the same access controls and retention limits to backup storage as
      to the database itself.

## 8. Application configuration

- [ ] Review `SPECBOARDS_BLOCK_PUBLIC_EMAIL_DOMAINS`: set it to `true` if you
      want to reject sign-ups from consumer email providers (gmail.com,
      outlook.com, ...). Off by default for self-host.
- [ ] Keep the deployment current: apply dependency and image updates promptly.
      The upstream CI audit gate (`pnpm run audit`) fails on high/critical
      production advisories; run it against your build if you fork or vendor.
- [ ] Run behind the reverse proxy / WAF you would use for any internet-facing
      service, and keep the host OS patched.
- [ ] **Set `SPECBOARDS_TRUST_PROXY=1` only if your proxy overwrites
      `x-forwarded-for`** (rather than appending to whatever the client sent).
      Rate limiting keys on the client IP; if that header is client-controlled,
      a caller gets a fresh bucket per request by varying it, and the limit
      reads as per-IP while providing none. Left unset, the app ignores the
      header and falls back to a single shared bucket for unidentifiable
      clients: blunter, but not forgeable. On Fly this does not arise, because
      `Fly-Client-IP` is set at the edge and takes precedence.

## 9. License notices (AGPL)

- [ ] The app ships an in-app source + license notice at `/legal`, linked from
      the sidebar footer, satisfying the AGPLv3 source-availability obligation
      out of the box. If you **modify** Specboards and expose it to users over a
      network, publish your modified source and point the notice at it. See
      [AGPL source availability](./AGPL-source-availability.md).
