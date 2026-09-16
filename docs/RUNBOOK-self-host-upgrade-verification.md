# RUNBOOK: self-host install and upgrade verification

Prove that somebody self-hosting Specboards can install it from nothing and
reach the current release by the documented path, with their data intact.

Run this **once per release**, before the release ships, on a machine with
Docker. It takes about twenty minutes, most of which is image pulls.

## Why this exists

Every upgrade we perform is on our own managed instance, where the database
already exists, the secrets are already set, and the schema is never more than
one release behind. A self-hoster has none of that. They install from an empty
volume, generate their own secrets, and may be several releases behind, which is
the case our own deploys never exercise.

The first run of this procedure, on 2026-09-16 against v1.3.0, found two
customer-facing defects in the upgrade path. Neither was visible from the code
and neither would have been caught by CI, because both are about what happens to
a *running instance* when a migration refuses.

## What you need

- Docker running, with ports 3000 and 5432 free on loopback.
- A clone of this repository with tags fetched (`git fetch --tags`).
- Nothing else. No GitHub credentials until step 7, which is optional and is
  the only step that needs an account.

> **This destroys the local `specboard_db` volume.** That is the same volume
> `pnpm db:up` uses for local development, so move any dev database you care
> about first. A genuinely fresh volume is the point of the exercise: an
> upgrade tested on top of an already-current schema tests nothing.

## 1. Start from nothing

```bash
docker rm -f specboards-web-1 specboards-migrate-1 specboards-db-1 2>/dev/null
docker volume rm specboard_db
docker volume ls | grep specboard   # must print nothing
```

## 2. Install the oldest version you support upgrading from

Use a worktree at that tag rather than your working copy: a self-hoster
installing v1.0.0 runs *v1.0.0's* `setup.sh` and *v1.0.0's* compose file, and
those differ from today's.

```bash
git worktree add /tmp/selfhost/v1.0.0 v1.0.0
cd /tmp/selfhost/v1.0.0
./setup.sh
```

Expect: secrets generated into `infra/.env`, image pulled, migrations applied,
and `Specboards is running at http://localhost:3000`.

## 3. Become the first user, by hand, in a browser

Deliberately manual. This is the one flow a customer cannot avoid doing
themselves, and it is the flow where a broken form is invisible to every
automated check we have.

Open http://localhost:3000 and:

1. Create the admin account. Any email works; no mail transport is configured,
   so nothing is sent and nothing needs verifying.
2. Name the organization and choose **Explore with sample data**. Sample data is
   the right choice here: it gives rows that have to survive the upgrade.

Confirm the board renders and the sidebar footer names a commit.

## 4. Record the baseline

Everything after this is a comparison against these numbers.

```bash
docker exec specboards-db-1 psql -U postgres -d specboard -tAc "
select 'migrations=' || (select count(*) from drizzle.__drizzle_migrations)
    || ' workspaces=' || (select count(*) from workspaces)
    || ' users='      || (select count(*) from users)
    || ' features='   || (select count(*) from features)
    || ' slug='       || (select string_agg(slug,',') from workspaces)"
```

## 5. Walk the documented upgrade path

Read the upgrade note at the top of `CHANGELOG.md` and follow it exactly,
including any hop it requires. Do not shortcut it because you know the schema:
the thing under test is the instruction, not the migration.

For each stop, use a worktree at that tag, carrying the **same** `infra/.env`
across so the secrets and the volume stay the customer's:

```bash
git worktree add /tmp/selfhost/v1.0.1 v1.0.1
cp /tmp/selfhost/v1.0.0/infra/.env /tmp/selfhost/v1.0.1/infra/.env
cd /tmp/selfhost/v1.0.1 && SPECBOARDS_VERSION=1.0.1 ./setup.sh
```

After each stop, before moving on:

```bash
docker inspect specboards-web-1 --format '{{.Config.Image}}'   # the version you meant
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep specboards
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health
```

`migrate` must show `Exited (0)`. **A web container reading `Created` rather
than `Up` means the instance is down**, whatever `setup.sh` printed.

> `setup.sh` pipes its output, so a run in a script buffers until it finishes.
> Do not read "no output yet" as "stuck"; check `docker ps` instead.

## 6. Verify the upgrade rather than assuming it

Re-run the baseline query from step 4. Every count must be identical except
`migrations`, which must have gone up. Then:

- The board still renders, still signed in as the same user, with the same items
  in the same columns. **The session surviving is part of the test**: it is what
  proves `BETTER_AUTH_SECRET` was carried across rather than regenerated.
- `/legal` names the commit of the version you just deployed, not the old one.
- Any route added by the new release answers (`/{org}/reviews` for 1.3.0), and
  any route not yet released 404s.

Check the tables the release added actually exist. A release whose migration
ran but whose feature is missing its table fails here and nowhere else:

```bash
docker exec specboards-db-1 psql -U postgres -d specboard -tAc "
select string_agg(table_name, ',' order by table_name)
from information_schema.tables
where table_schema='public' and table_name in ('proposals','agent_runs')"
```

## 7. Prove the agent surface works on a self-host

A self-host is where a missing migration or an absent secret shows up first.
Create an API key in Settings, then:

```bash
KEY=sb_...
curl -s -X POST http://localhost:3000/api/mcp \
  -H "authorization: Bearer $KEY" -H "x-org-slug: <your-org>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

`whoami` returns the workspace's level keys. Use one of those in a
`create_item` call and confirm the row lands, which proves the write path and
not just authentication.

## 8. Connect a repository (manual, needs a GitHub account)

**Deliberately manual, and deliberately last.** It needs an interactive GitHub
login with 2FA and a downloaded private key, so it cannot be scripted and
should not be done with somebody else's credentials.

On `localhost`, GitHub cannot reach the instance, so the one-click App creation
is correctly refused and the manual path is offered instead. Settings >
Integrations > Repositories walks it: create the App from the prefilled link,
collect the App ID, client secret and private key, paste them back, then
install the App.

Two things to confirm while you are there, because both have bitten before:

- The **Members: Read-only** organization permission is present. Without it,
  every organization install fails at the last step.
- The webhook is **off**, and the page says why: a localhost instance cannot
  receive deliveries, so pushes on GitHub will not flow back. Writes from
  Specboards to GitHub still work, because those are outbound.

Then prove the round trip both ways: import an existing spec repo and confirm
the specs appear as items, then edit a spec here and confirm the commit lands.

To test the inbound half you need a public HTTPS origin. Put a tunnel in front
of the instance and set `APP_URL` to the tunnel's address before creating the
App, since the App's callback and webhook URLs are baked in at creation.

## 9. Tear down

```bash
cd /tmp/selfhost/v1.0.0 && ./setup.sh --destroy
git worktree remove /tmp/selfhost/v1.0.0   # and each other tag
```

## File what you find, do not fix it in passing

A divergence between this procedure and what actually happens is a defect in
the docs, and it should get a card like any other. Fixing it silently while
testing it destroys the evidence that it was ever wrong, and the next release
has no way to know the step was ever a problem.
