# Runbook — Marketing site (www.specboard.ai)

The public landing site is a **separate** Next app (`apps/marketing`) deployed as
its own Fly app (`specboard-www`), independent of the product app
(`specboard` → app.specboard.ai). It has no database, auth, or secrets — it's a
fully static page.

| Host | Serves | Fly app |
| --- | --- | --- |
| `www.specboard.ai` | marketing landing page | `specboard-www` |
| `specboard.ai` (apex) | 308-redirects to `www` | `specboard-www` |
| `app.specboard.ai` | the product app | `specboard` |

## Deploy

```bash
# Manual
fly deploy -c fly.marketing.toml --remote-only

# CI: a push to main touching apps/marketing/** (or its infra) auto-deploys via
# the deploy-marketing job in .github/workflows/fly-deploy.yml. Manual dispatch:
gh workflow run fly-deploy.yml -f environment=marketing
```

CI uses the `FLY_API_TOKEN_MARKETING` repo secret (an app-scoped Fly deploy
token for `specboard-www`).

## DNS (one-time, at the specboard.ai registrar)

Point both hosts at the `specboard-www` Fly IPs:

| Record | Name | Value |
| --- | --- | --- |
| A | `www` | `66.241.124.12` |
| AAAA | `www` | `2a09:8280:1::12f:f74d:0` |
| A | `@` (apex) | `66.241.124.12` |
| AAAA | `@` (apex) | `2a09:8280:1::12f:f74d:0` |

> The v4 is a Fly **shared** IP (host-routed) — fine for both apex and www.
> Re-check the current IPs with `fly ips list -a specboard-www` if they change.

Then watch certs issue (Let's Encrypt, once DNS resolves):

```bash
fly certs check www.specboard.ai -a specboard-www
fly certs check specboard.ai      -a specboard-www
```

## Config

CTAs and links are baked at build time from env, with production defaults in
`apps/marketing/src/lib/site.ts`:

- `NEXT_PUBLIC_APP_URL` (default `https://app.specboard.ai`) — sign-in / sign-up.
- `NEXT_PUBLIC_GITHUB_URL` (default `https://github.com/StudioPalouse/SpecBoard`).

To point a deploy elsewhere, pass them as build args / Fly build env.

## Verify

```bash
curl -I https://specboard-www.fly.dev/          # always reachable (Fly host)
curl -I https://www.specboard.ai/               # 200 once DNS + cert are live
curl -sI https://specboard.ai/ | grep -i location  # -> https://www.specboard.ai/
```
