# Changelog

All notable changes to Specboard are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/). See [VERSIONING.md](./VERSIONING.md)
for how and when the version is bumped.

> **Gap notice.** Versions **0.22.0 through 0.25.2**, and again **0.27.0** and
> **0.27.2**, shipped to production without a changelog entry, a version bump,
> or a git tag. The repo sat at `0.21.0` across the first six releases while
> `app.specboards.ai` moved well past it, and tagging stopped at `v0.19.0`;
> after this notice was written it happened twice more, with the repo reading
> `0.26.8` while production ran 0.27.2. Their contents are recorded in each
> release's notes in Specboards, not here.
>
> **The gap will not be backfilled** (decided 2026-08-23). No commit carries
> those version numbers, so a tag added now would name source whose
> `package.json` disagrees with it, and an entry written now would be
> reconstructed rather than recorded. The Specboards release notes are the
> record for that stretch; this file is the record from the next release on.
>
> **This can no longer recur.** `scripts/release-guard.sh` refuses a production
> deploy whose version is not bumped in lockstep, described here, and tagged on
> the commit being shipped. It runs on both routes to production, the local
> `pnpm deploy:prod` and the dispatched workflow. See
> [VERSIONING.md](./VERSIONING.md).

## [0.31.0] - 2026-09-01

0.30.0 made self-hosting install. This release makes it **connect**.

Someone ran the whole thing end to end against a real GitHub organization,
stopping at every point a self-hoster would stop, and this is the result. The
headline: an on-prem instance could not connect to GitHub at all. Not "was
awkward to connect", could not. Three separate defects stacked on one path, and
because the hosted product never takes that path, all three had been shipping
undetected since the flow was added in mid-June.

### Added

- **A self-hosted instance can connect to GitHub.** GitHub's one-click App
  creation validates that it can reach your webhook URL and refuses when it
  cannot, so every deployment behind a firewall was excluded from it by
  construction. There was no second path: the function that stores App
  credentials had exactly one caller, the one-click callback. An operator who
  could not use that flow had nowhere to go. Credentials can now be entered
  directly, and the instance verifies them against GitHub before saving, so a
  wrong value is refused while you are still looking at the field rather than
  at the first sync.
- **The setup card walks you through creating the App, with the form already
  filled in.** GitHub accepts its entire New GitHub App form as URL parameters,
  permissions included, so the link does that for you. This matters most for
  the permissions: miss one and GitHub creates the App happily, the settings
  page looks correct, and it surfaces much later as an installation that fails
  at the final step with nothing on screen connecting the two. The values are
  still listed, now as something to confirm rather than transcribe.
- **`/api/health?full=1` reports what is actually running:** version, commit,
  whether the database is reachable, and how many migrations are applied. The
  bare `/api/health` is unchanged for load balancers.

### Changed

- **The controls that create specs are named after what they create.** "New
  spec" on a Feature reads as "give this feature a spec", which is the one
  thing it does not do: it creates a *different* item beneath it, and the
  Feature stays undocumented. It now reads "New Work Item" (or whatever the
  workspace calls its leaf level), and the expanded form says plainly that it
  does not document the item you are looking at. Grouping levels, which cannot
  take a spec at all, now say so and link to the control that can, instead of
  leaving a nearby button to be misread as one.
- **The GitHub setup card shows only the fields an operator can act on.** Values
  that are ours to supply are reference rows with copy buttons rather than
  disabled-looking inputs, and the webhook secret is hidden entirely on an
  origin GitHub cannot reach, where it would be an inert control asking for a
  secret nothing will ever verify.

### Fixed

- **A fresh instance opens on account creation, not on a sign-in page.** The
  first person to reach a new self-host was shown a form for an account that
  could not exist yet, with the sign-up link below the fold.
- **The browser could reach GitHub's App-creation endpoint.** The
  Content-Security-Policy sent on every response set `form-action 'self'`, which
  silently blocked the POST to github.com that the flow is built on. The
  exception is scoped to that one path.
- **The setup cookie works over plain HTTP.** It was marked `Secure`
  unconditionally, so on an internal HTTP origin the browser dropped it and the
  install failed at the final callback with no explanation.
- **A stack served over plain HTTP no longer half-starts an unreachable flow.**
  The App-creation route now checks up front whether GitHub could reach this
  origin and explains what to do instead, rather than handing off to GitHub and
  failing there.
- **`docker compose up --build` bakes in the version as well as the commit.**
  `migrate` and `web` resolve to the same image tag, so Compose builds it once
  using whichever service it happened to pick. Their build arguments differed,
  and the one that won lacked the version, so a stack built with the version on
  the command line reported `"version": null`.
- **The repository list no longer contradicts itself.** Creating a spec repo
  reported success while the panel above still read "No repositories
  connected", because that list came from a server render that the refresh
  could not be awaited on.
- **`setup.sh` upgrades an existing `.env`** rather than leaving a stack running
  on an old one that is missing newly required keys.

## [0.30.1] - 2026-08-31

Hardening on 0.30.0's self-host work, and metadata on the published image.

### Fixed

- **Email verification is relaxed only where a deployment has said it is a
  self-host.** 0.30.0 stopped requiring verification when a deployment was
  single-tenant and had no mail transport, which was right for the case it was
  written for and wrong as a rule: single-tenant is what you get by setting
  nothing, so it also described any hosted deployment that had lost a
  configuration variable. Such a deployment would have quietly stopped
  requiring verification, with nothing to signal it. It now takes all three of
  `SPECBOARDS_SELF_HOST=true`, single-tenant, and no configured mail
  transport, so the strict behaviour is what a deployment gets by default and
  the relaxed one has to be asked for. No hosted deployment was affected: ours
  is multi-tenant with mail configured, which satisfied the old rule twice
  over.

### Changed

- **The published image declares its provenance.** `ghcr.io/specboards/specboards`
  now carries the standard OCI labels, including `org.opencontainers.image.source`
  pointing at this repository and `AGPL-3.0-only` as the license, so scanners and
  registries can read where a running binary came from and what it is licensed
  under without being told.

## [0.30.0] - 2026-08-31

Self-hosting works. Before this release it did not, and we had never checked.

Someone installed Specboards from a clean machine using only the README, wrote
down every place they stopped, and this is the result. They could not get a
working instance. The stack came up against an empty database and returned a
500 on the first thing anyone does; the first admin was then locked out of
their own instance by a verification email that could never arrive. Both had
been true for as long as the self-host path had existed, because every
environment we run migrates itself and sends mail, and the one we hand to other
people did neither.

### Added

- **One command installs Specboards.** `./setup.sh` checks the prerequisites and
  the ports, generates the secrets, pulls the image, applies the migrations,
  starts the stack, and waits until it answers. There is nothing to edit and no
  second command. `--stop`, `--destroy`, and `--build` cover the rest; re-running
  is safe and takes about three seconds.
- **A published container image**, `ghcr.io/specboards/specboards`, built for
  linux/amd64 and linux/arm64 on every release. Self-hosting is now a pull
  rather than a clone-and-compile, and you can choose your version:
  `SPECBOARDS_VERSION=0.30.0`, or pin the manifest digest recorded with each
  release, since a tag can be moved and a digest cannot. `SPECBOARDS_IMAGE`
  points the stack at your own registry or fork. Building from source stays a
  first-class path, which the AGPL positively invites: `./setup.sh --build`.
- **A daily check that the documented install still works.** It runs
  `./setup.sh` exactly as the README tells you to, then asserts the app serves,
  the database really has a schema, and a first account can be created and
  signed in. Nothing previously asked that question, which is how the path
  stayed broken.

### Fixed

- **The self-hosted stack now applies its own migrations.** It came up with an
  empty database and looked healthy: the sign-up page rendered, and the first
  write failed with `relation "outbox_events" does not exist`. The migration
  step existed for our cloud deploys and had simply never been added here.
- **A self-host with no mail configured can create its first account.** Sign-up
  demanded an emailed verification link, and with no mail transport that link
  was discarded and its token never stored, so the instance could not be entered
  at all. Verification is now required only where it can actually be delivered:
  always on a multi-tenant deployment, always when email is configured, and not
  on a single-tenant self-host that has none.
- **The sign-up page no longer asks self-hosters for a code they cannot have.**
  The "Sign-up code" field belongs to our hosted beta and appeared on every
  deployment; the first user of a self-host is by definition a new team, so it
  read as a wall in front of a door that was open.
- **A new workspace opens on a board with something on it.** Choosing "Explore
  with sample data" landed on an empty Features tab while the four starter
  cards, one of them titled "Welcome to Specboards", sat one tab away.
- **Two checkouts on one machine no longer share a database.** The compose
  project took its name from a directory, so every clone resolved to the same
  volume and each believed it owned the data. The volume now has a fixed name of
  its own. If you installed before this, `./setup.sh` finds your old database
  and offers to bring it across rather than quietly starting empty beside it.
- **`pnpm db:up` works on a fresh clone**, instead of failing on a secret only
  the web service reads.
- **Migration output reads like progress rather than failure.** It printed raw
  Postgres notices that look like errors, and said "schema up to date" on the run
  that created the entire schema. It now says how many migrations it applied.

### Internal

- One migration runner for development and production, where `pnpm db:migrate`
  and the deployed release command previously used different code.

## [0.29.4] - 2026-08-31

A release can now say when it actually shipped, rather than only when someone
pressed the button. Both halves of that arrived from the same place: recording
the previous release through the MCP tool produced a shipped release with no
ship date, and fixing it made obvious that there was no way to enter a past one
either.

### Added

- **A release can carry a historical ship date.** `shippedDate` is accepted when
  a release is created and when it is edited, so a release that shipped in July
  can say so, and a date stamped on the wrong day can be corrected without
  reopening the release and shipping it a second time. It is reachable
  everywhere the rest of a release is: both API request shapes, the
  `create_release` and `update_release` MCP tools, and the release detail sheet,
  where "Actual ship date" was a read-only line of text and is now an editable
  date.
- **The rule about ship dates is stated once instead of four times.** A release
  has a ship date if and only if it is shipped; a caller-named date wins and may
  be in the past, otherwise a release that has just shipped is stamped today and
  one already shipped keeps what it had. That now lives in `@specboards/core`
  alongside the cycle-date rule, because two stores and two request parsers all
  have to reach the same answer, and the previous way they stopped agreeing was
  that only one of them knew the rule. Both ends are enforced rather than
  assumed: an unshipped release cannot be given a ship date, and a shipped one
  cannot have its date cleared.

### Fixed

- **A release created already shipped is no longer stored without a ship date.**
  Both stores only ever stamped `shippedDate` on the transition into `shipped`,
  so a release created with that status went in with none, and nothing
  downstream could recover: the roadmap draws a shipped release's bar from that
  date, the detail sheet prints it, the dashboard appends it, and release
  sorting reads it before falling back to the target date. Such a release sorted
  as though it had no date and rendered as though it had never shipped. The only
  workaround was to flip the status to in-progress and back so the transition
  would fire. No data repair was needed: of the 33 shipped releases in
  production, the single affected row had already been corrected by hand.
- **Local file mode and the Postgres store agree on what "today" is.** Local
  mode was computing it inline while the Postgres store used core's
  `todayDateOnly`. One definition per codebase now.

### Documentation

- **The outbound webhook delivery contract is written down.** Webhooks have been
  live since 0.29.x with no documentation a receiver author could use; the only
  description of the envelope, payloads and signing scheme was a planning
  document that had gone stale enough to be deleted, since it still called the
  durable outbox "V2 only" after the drainer had shipped.
  `docs/GUIDE-webhooks.md` replaces it, written for a consumer rather than for
  us, with every claim checked against the source. It gives the most room to the
  parts most easily got wrong: verify the signature against the raw body before
  any parse and re-serialize, delivery is at least once and both causes are
  named, dedupe on the envelope id (which identifies a delivery, not a change,
  so one change fanned out to two endpoints has two), there is no ordering
  guarantee, and a delivery is abandoned after six attempts over about 8h36m
  with no way to replay it.

### Internal

- **The store directory is prettier-clean.** The twenty files in
  `apps/web/src/lib/store/` that the split left unformatted, the `db/` modules,
  `types.ts`, and the test suites, reformatted on their own so the reflow is not
  sitting underneath the next real change to them. `pnpm format` is a command
  someone runs rather than a gate, so an unformatted file stays that way until
  something else touches it. Nothing in the diff is more than a line break bar
  106 characters of inert punctuation, confirmed by stripping all whitespace
  from every file before and after and comparing character by character.

## [0.29.3] - 2026-08-31

Nothing in the product behaves differently in this release, and that is the
whole claim it makes. It is the store split finishing, shipped on its own so
that the change nobody can see is not sitting underneath the next one that can.

### Internal

- **`FeatureStore`, a 104-member interface implemented twice, is now twenty-four
  domain modules behind two maps.** Everything the product reads or writes went
  through three files: a 1,999-line interface, a 6,639-line implementation of it
  against Postgres, and a 3,360-line implementation of the same interface again
  for local file mode. The Postgres one had no section comments anywhere in it,
  so there was no way to navigate it except search, and no way to review a change
  to it in context. The interface is now twelve composed per-domain interfaces,
  and each store is a directory of twelve modules with an index that delegates:
  `db/index.ts` is 989 lines where it was 6,707, and `local/index.ts` is 1,170
  where it was 3,531. Callers still hold the same object and no test moved.
- **The split is believable because it was counted rather than asserted.** Across
  the twenty-four pull requests that moved a domain, one each, no method body was
  ever retyped: each was sliced out by script and diffed against the parent commit
  with exactly three mechanical edits permitted and reversed before comparing.
  Anything else in that diff stopped the pull request. The authorization checks
  were counted on every single one, 32 `canWriteProductId` and 25
  `canReadProductId` across the Postgres store, identical from the first domain
  moved to the last. The integration suite ran against a real Postgres with
  row-level security active throughout.
- **Dead code fails the build.** Unused exports, unused files and unused
  dependencies are now reported by `knip` in CI, after the existing inventory was
  taken to zero. The three deliberate exceptions are `@public` tags next to the
  code that explain themselves, rather than entries in a config file that do not.
  It earned its place immediately by catching three over-exported types in the
  split's own new code within an hour of landing.

## [0.29.2] - 2026-08-30

Cards that say what they mean, and progress that counts your workflow rather
than ours.

### Fixed

- **Cards name the level their children are actually at.** The badge on a card
  with children read `epic 3/5` at every altitude. It is a count of finished
  children, so on an Initiative it happened to be right and everywhere else it
  was not: on an Epic it counted Features while calling them epics, and on a
  renamed hierarchy it meant nothing at all. It now reads `3/5 Features done`,
  naming whatever your child level is called, with the word "done" in it because
  `3/5` on its own reads as an id or a position rather than as progress. The
  companion badge on a child card says `↳ Epic` instead of `↳ sub`, naming the
  real parent level. The board and the backlog table now draw this from one
  component, so the two can no longer drift, and both agree with the item
  drawer, which was already right.
- **Progress counts your last stage, not a stage called "done".** Every derived
  figure in the product asked whether an item's status was literally `done`,
  which is only the last stage of the built-in workflow. A workspace whose
  stages end in `shipped` therefore saw all of them sit at zero: child roll-up
  on cards, cycle totals, goal delivery, release progress, and the roadmap
  progress bars drawn from the roll-up. Nothing errored, so the effect was a
  product that simply looked permanently stalled no matter how much work
  finished. Doneness is now the last stage of whichever stage set applies,
  resolved the same way the workflow itself is: the product's own stages, then
  the workspace default, then `.specboards/config.yml`, then the built-in set.
  Each item is judged by its own product, so a board spanning products whose
  stages disagree stays honest about each. Archiving is still never doneness,
  and rolling a cycle over still leaves finished work behind, now by that same
  definition.
- **Card display settings no longer describe themselves as epic-specific.**
  "Epic progress" and "Sub-feature badge" are now "Child progress" and "Parent
  level badge". Boards keep whichever fields they had turned on.

### Changed

- **The Postgres store split continues.** Several more domains each moved into
  a module of their own, among them saved views, releases, docs, goals, ideas,
  and the comment and notification methods, continuing the one-domain-at-a-time
  work started in 0.29.1. No behaviour changed.

## [0.29.1] - 2026-08-30

A workflow you can edit again, and the beginning of a much smaller store.

### Fixed

- **Settings > Cards can save your workflow stages again.** Renaming, adding,
  reordering, or removing a board column, giving a product its own set of
  stages, and reverting a product to the workspace default were all dead: the
  browser sent a request the server had no handler for and got a 405 back. The
  handler was removed by accident during the change that made these settings
  per-product, and because the API description was updated to match the server
  rather than the browser, nothing disagreed with anything and the feature sat
  broken. It works again, with the same permissions as the rest of that page: a
  product admin configures their own product, the workspace owner configures
  any, and the workspace default stays owner-only.
- **Removing a stage no longer leaves work with nowhere to sit.** An item in a
  stage you delete is moved to the first stage, which is what was always
  intended. Reverting a product to the workspace default is the case that was
  wrong: items on a stage only that product had were left pointing at a column
  the board no longer draws, invisible until someone went looking. Local file
  mode never did this re-homing at all and now does.
- **Local file mode puts new specs in your first stage**, not in a stage called
  "backlog" that may not exist. A spec nobody had moved yet showed up under a
  column that was not on the board if you had renamed or removed that stage.
- **The dev server starts, and the build no longer dirties the tree.** Both
  reported by anyone setting the repo up from scratch.

### Changed

- **The Postgres store is being taken apart.** `db.ts` was 6,700 lines with no
  internal structure, and the interface behind it had 104 members implemented
  twice over. It now has navigable sections, twelve domain interfaces instead of
  one, its own directory, and the first domain (cycles) moved into a module of
  its own. No behaviour changed: this is groundwork so that later changes to the
  store are reviewable, and it continues one domain at a time.
- **Unused code now fails the build in `apps/web`.** It was checked by nothing,
  in the package that is most of the codebase, which is how the missing workflow
  handler above went unnoticed: the imports it left behind were the only
  evidence.
- **A trimmed set of documents.** The progress-tracking files that had drifted
  out of date are gone and `docs/` has an index, so what remains is what is
  still true. The README leads with the agentic harness and maps it to the
  AI-native SDLC.

## [0.29.0] - 2026-08-30

The CLI stops being something you build from this repo and becomes something you
install.

### Added

- **`@specboards/cli` is published to npm.** `npx @specboards/cli whoami` runs it
  without installing anything; `npm i -g @specboards/cli` puts `specboards` on
  your PATH. Until now the CLI existed only as source in `apps/cli`, so using it
  meant cloning the monorepo and building it, which is a lot to ask of someone
  who wanted to check a work item's status. The published package has no runtime
  dependencies, so the download is the whole thing.
- **`brew install specboards/tap/specboards`.** The tap
  ([Specboards/homebrew-tap](https://github.com/Specboards/homebrew-tap)) is
  live. The README has advertised this command for some time; it now works.
- **The formula keeps itself current.** A job in the tap watches npm, and when a
  new CLI version appears it downloads that exact tarball, computes the checksum
  from the bytes it fetched, then installs and runs the result on macOS before
  committing. So a CLI release reaches `brew install` without anyone editing a
  formula, and a formula that would not install never gets pushed.

### Changed

- **The CLI is Apache-2.0, and now says so everywhere.** The package metadata
  claimed AGPL-3.0, matching the rest of the repo rather than the deliberate
  exception described in `LICENSING.md`. The CLI is meant to be freely
  scriptable against, including commercially, and npm was telling people
  otherwise. The manifest, `apps/cli/LICENSE`, and the Homebrew formula now
  agree.
- **The Homebrew formula lives in the tap, and only there.** `packaging/homebrew`
  used to hold a second copy that had to be kept byte-identical by hand. Now that
  the bump is automated that copy would be stale within hours of every release,
  so it is gone and the directory explains where the formula went and why.

### Fixed

- **Install instructions that did not work.** `apps/cli/README.md`, which doubles
  as the npm listing page, described a Homebrew tap that did not exist yet, and
  the formula pointed at version 0.21.0 with a placeholder checksum of all zeros.
  Both now name a real, published, verified release.

## [0.27.3] - 2026-08-23

Key results you can actually maintain, and a release process that checks itself.

### Added

- **Key results can be edited, and reordered.** Until now a key result was
  write-once apart from its current value: get the title, the metric or the
  target wrong and the only way out was to remove it and start again, losing
  every check-in you had recorded against it. Each one now carries an **Edit**
  control that opens the same fields you filled in to create it and closes again
  when you save, and **↑ / ↓** controls to put them in the order you want to read
  them in. The arrows are ordinary buttons rather than a drag handle, so they
  work from the keyboard and announce which key result they move.

### Changed

- **A yes-no key result stops asking for numbers.** Choosing "Yes-no" used to
  leave the From and To boxes on screen and refuse to save until you invented
  values for them, which is a strange thing to ask about a question whose only
  answers are yes and no. There is no target to set any more, because the target
  of "did we do it" is always yes. You say whether it **starts** as Yes or No,
  which matters when you are recording something that was already true when you
  wrote it down, and you check it off with a Yes/No control rather than by typing
  a number. Worth knowing: a yes-no key result that starts as Yes reads 100% from
  the moment it is created.
- **New key results are measured as a percentage by default**, since most are
  proportions, and the menu now names the options (Percentage, Number, Yes-no)
  instead of showing the internal keys. If you create key results through the API
  or an agent, nothing changes: leaving the metric unstated still means a number,
  exactly as before.

### Fixed

- **Key results stop rearranging themselves.** They are stored with an order and
  that order was never being read, so the sequence you saw was whatever the
  database happened to return, and it could change. In practice, checking in a
  number against one key result could silently reshuffle the others. Both places
  that read them (a goal, and the Goals page) are fixed, so the two agree.

### Security

- **Two dependencies carrying security-relevant code are now current.** `undici`,
  which implements the defence that stops a server-side fetch being redirected to
  a private address, moved from 6.28.0 to 8.10.0; that defence is now covered by
  a test over HTTPS, the transport it actually runs on, where previously only the
  plaintext path was covered. `octokit` moved from 4.1.4 to 5.0.5.
- **A build that would ship with its scripts blocked now fails the test suite.**
  Our content-security policy admits only scripts carrying a per-request token,
  and the tests checked that the policy was correct without ever checking that
  the page's scripts carried the token. A build could therefore pass every test
  and be inert in the browser. The tests now read what the browser receives, and
  confirm the page comes alive under the policy.

### Internal

- **A production deploy is refused unless it is a real release.** Eight releases
  reached production without a version bump, a changelog entry or a tag, twice
  after the changelog gained a notice describing exactly that. The rule no longer
  depends on remembering it: `scripts/release-guard.sh` checks all three at the
  moment of deploying and refuses otherwise, on both routes to production.
  `pnpm release:prepare <version>` does the bump and scaffolds this section, so
  the enforced path is also the quickest one. This release is the first through
  it.

## [0.26.8] - 2026-08-18

### Added

- **The assistant, on a release.** Releases carry the same assistant panel an
  item does: a conversation that stays with the release, and drafts of the
  customer-facing notes that arrive as proposals you review as a diff and accept
  or reject. Nothing it writes is saved until somebody accepts it, and accepting
  goes through the same write the notes editor uses. It is given the work
  scheduled into the release, including each item's description, because from
  titles alone a model has to guess what a change meant for a customer and
  guessing is how an invented release note gets written. What is sent is listed
  in the panel before anyone spends a token: assignees and the internal planning
  notes are not part of it. A release too large to send whole is shortened
  deliberately rather than failing, paying for every item's title first and
  sharing what is left evenly between the descriptions, and every cut is
  reported rather than left to be noticed. Two release skills ship, "Draft the
  notes" and "Tighten these notes"; skills now belong to a surface, so the
  buttons on an item and the buttons on a release are separate sets a team
  arranges independently.
- **MCP tools for the Plan doc areas.** Strategy, Research and Architecture are
  now managed by agents, not just read by people: `list_docs`, `read_doc`,
  `create_doc`, `update_doc` and `delete_doc`. One set of tools covers every way
  an area can be backed, because which one a team picked is a setup detail an
  agent should not have to reason about: pages Specboards holds, or Markdown in
  a connected GitHub repo (there a page's id **is** its repo path, edits are
  commits, and a rename moves the file). An area that only links out is
  read-only, and one with no source chosen yet adopts Specboards-held pages on
  the first `create_doc`, so a page an agent writes is visible in the app
  instead of hidden behind the setup chooser. Deleting a folder that still holds
  pages needs an explicit `deleteChildren: true`.
- **The missing goal verbs**: `read_goal` (a goal with its key results _and_ the
  work linked to it, which `list_goals` omits), `delete_goal` and
  `delete_key_result`. `read_item` now reports the goals an item ladders up to,
  so the "why does this exist" edge reads from both ends.
- **Access requests are kept, not just emailed.** `POST /api/access-request`
  used to send two emails and leave no record, so nothing tracked which requests
  had been dealt with. Submissions now land in `access_requests`, which is the
  queue an operator works from. A repeat submission refreshes the request
  already open for that address rather than queueing a duplicate, and keeps its
  original place in the line. Persisting is best-effort on purpose: the review
  inbox reached a human before this table existed and still does, so a storage
  failure logs, still sends, and says in the notification that this one is not
  in the queue. Deciding a request is an operator action outside this repo; on
  the hosted service it lives in the internal admin console, which is granted
  UPDATE on this one table.
- **Usage accounting and spend guardrails for your model connection.** Every
  call Specboards makes to the endpoint you connected is now recorded (which
  feature asked for it, on whose behalf, what it cost, and how it ended), and
  Settings → Integrations → Usage shows the month's spend broken down by feature
  and by person. You pay your provider for those tokens, so the honest thing is
  to be able to explain a line on that invoice rather than ask you to accept it.
  Counted in tokens rather than money: the price of a token is between you and
  your provider, and a currency figure we invented would look authoritative and
  be wrong. Owners can set a monthly cap for the workspace and a daily cap per
  person; a request that would cross one is refused before it is sent, and the
  person is told which cap was hit and who can raise it. The assistant panel and
  the breakdown button both now say roughly how many tokens they are about to
  send, so the size of a request is visible before anyone spends on it. A call
  the endpoint reported no usage for is counted as unmeasured rather than as
  free, and the screen says how many, so a runtime that omits usage does not
  quietly look like zero spend.

### Security

- **`access_requests` is unreadable from the tenant connection.** The table
  holds contact details for people who are not customers, so it carries RLS with
  no policies at all, which denies every row to the non-owner `specboards_app`
  role. Migration 0073 also revokes that role's table privileges, which
  `ALTER DEFAULT PRIVILEGES` had granted automatically on table creation
  (`infra/rls-role.sql` section 3) despite 0072 intending otherwise. Nothing was
  ever exposed, since RLS denied the rows regardless; this restores the layer
  underneath, so a future policy on this table cannot silently confer DML.

## [0.26.0] - 2026-08-07

Where goals surface once they exist, a board you can actually drop a card on,
and scoring that explains itself.

### Added

- **Goal roll-up on the portfolio dashboard.** `/{org}/dashboard` now carries a
  Goals section: each goal's status, product, period, and both progress figures,
  still labelled and still never merged. Hidden entirely until a goal exists.
- **Goal swimlanes on the roadmap timeline.** A third option on the timeline's
  rows toggle (`?rows=goals`), beside "By release" and "Laddered": one lane per
  goal, drawn over its measurement period, with the work laddering up to it
  inside. The band fills with **outcome** progress and states delivery beside
  it. Two things follow from what a goal is: a lane is not a partition (work
  serving two goals is drawn in both), and the level switcher does not filter it
  (a goal is served by an initiative and a single work item alike). Goals with
  no period, and work that ladders up to nothing, are trayed rather than
  dropped. New `listGoalLinks` store method reads the whole link graph in one
  call.
- **Nested goals render as a tree.** The Goals page lays goals out by
  `parentGoalId` instead of listing them flat, so a company objective and the
  product goals under it read as one ladder. A goal whose parent is out of scope
  is promoted to the top level and says whose it is; editing it no longer
  silently detaches it from that parent.

### Changed

- **RICE is scored in a flyout, one scale per input.** The four values used to
  sit in the item's properties row as look-alike boxes whose units and scales
  you had to already know, and which mean nothing apart from each other. They
  now open from the RICE row: Reach on a magnitude ladder plus a free field,
  Impact on the canonical five-step scale, Confidence on a slider with the
  Low/Medium/High anchors, Effort on a person-month ladder, with the running
  score and its formula underneath. The row reads as the score plus a compact
  breakdown.

### Fixed

- **Board cards can be grabbed, and drops land where you aim.** The whole card
  was a click target, so the zone that opened an item was far larger than the
  title it looked like, and a drag that fell short of the threshold opened the
  drawer instead. The card body is now the drag handle and only the title opens
  the item (below md, where drag is off, the whole card stays a tap target).
  Dropping is more forgiving in three ways: cards tile their column with no dead
  gaps between them, a drop on a card's lower half inserts after it, and a
  within-column drag commits what the preview showed rather than landing one
  slot above it. Desktop columns stop at the bottom of the viewport and scroll
  inside, and a column taller than it can show floats "Drop at top" / "Drop at
  end" bars over its edges so both ends stay one move away instead of a
  drag-scroll away. A cancelled drag (Escape, a resize, the tab going
  background) no longer leaves the overlay card stuck to the cursor, and the
  Roadmap column's drop target fills the column rather than stopping at its last
  card.
- **New items pick up their level's detail template on every path.** An item
  created from a column quick add came out blank even where the level had a
  template assigned: the quick add posts a title and nothing else, and the
  template was only ever applied by the "New item" drawer. It is seeded on
  create now, so the REST API and the MCP tools behave like the UI. Clearing the
  drawer's editor still creates a blank body.
- **`GIT_SHA` is passed on every deploy path.** /legal's "Source code" link
  pins to the running commit (the AGPL section 13 offer), but the build arg that
  bakes it in was only ever passed by hand, so three releases shipped pointing
  at the repo root instead. The GitHub workflow now passes it for both test and
  production, and local deploys go through `pnpm deploy:test` /
  `pnpm deploy:prod` (`scripts/deploy.sh`), which supplies it and refuses to
  ship production from a feature branch or a dirty tree.

## [0.25.5] - 2026-07-27

Planning entities: two new first-class records, and a change to what a work item
fundamentally is.

### Added

- **Goals and key results** (gh-27). A goal states an outcome with a measurable
  target and a period, and is deliberately **not** a hierarchy level: it is
  measured, and the work serving it is many-to-many across products, neither of
  which the single-parent item hierarchy can express. New `goals`, `key_results`
  and `goal_links` tables (migration 0052), a Goals area under Plan, a Goals
  section on every item, REST endpoints, and six MCP tools. Each goal carries
  **two** progress figures that are never merged: `progress` (the mean of its key
  results, i.e. did the outcome move) and `deliveryProgress` (the share of linked
  work done, i.e. did we ship it). Both are computed on read. Key-result progress
  measures distance travelled from a baseline rather than distance to a target,
  so decreasing metrics need no special case.
- **Cycles** (gh-28). Sprints and iterations as a second, orthogonal axis to
  releases: an item can be in a release _and_ a cycle, and clearing one leaves
  the other untouched. New `cycles` table plus `features.cycle_id` (migration
  0051), a Cycles area under Build, a `?cycle=` backlog filter, a bulk control,
  and four MCP tools. A cycle has **no stored status**: it is upcoming, active or
  complete purely from its dates, so it can never be stale and nothing has to run
  to keep it current. Rollover is an explicit action that leaves finished work in
  the cycle that delivered it.

### Changed

- **A spec is now an attachment to a work item, not its identity**
  ([ADR 0003](./docs/adr/0003-spec-as-attachment.md)). Work items can be created
  at every level including the leaf, so work done by a person rather than an
  agent is tracked and rolls up like any other, instead of needing a spec file
  written for it. `isDbNative` is re-derived from `spec_index` presence rather
  than `repo_id`, which stopped meaning the same thing once a repo-less leaf row
  became possible. `create_spec(workItemId)` attaches a spec to an item that
  already exists rather than creating a second card for the same work.
- **Sync no longer auto-creates Feature grouping cards.** An imported spec that
  matches no existing grouping lands unparented in Unassigned, and the import
  summary reports how many did. This retires the mechanism the v0.25.0
  wrapper-orphan bug came from. Existing groupings are untouched.
- Deleting a work item that has a spec attached now removes the spec file from
  git in the same operation, behind an explicit confirmation. Deleting the row
  alone let the next sync re-import the spec and silently recreate the item.

## [Unreleased]

### Changed

- **Relicensed the core from Apache-2.0 to AGPL-3.0-only.** The Specboard server
  and web app are now open source under the GNU Affero General Public License v3,
  with a commercial license available for the cases the AGPL does not fit
  (reselling Specboard as a hosted service, embedding it in proprietary software,
  or needing enterprise add-ons and support). See
  [LICENSING.md](./LICENSING.md) for the dual-license model. The published
  `@specboard/cli` (`apps/cli/`) stays Apache-2.0 so customers can embed it
  freely. Contributions are now covered by a CLA
  ([CONTRIBUTING.md](./CONTRIBUTING.md)) that grants the right to relicense them
  commercially, which is what makes the dual-license model hold. Releases v0.21.0
  and earlier remain available under Apache-2.0.

## [0.21.0] - 2026-07-21

Dogfood loop & public API: make the PR -> work-item-status loop consumable by
external customers and close the gaps in the public REST surface.

### Added

- **Auto-advance the sync loop past multi-step transitions.** The CLI's
  `specboard status <spec> <target> --advance` walks a spec through the shortest
  legal chain of intermediate statuses (e.g. `backlog -> defining -> ready ->
in_progress`) instead of stopping at the first illegal jump. `GET
/api/v1/statuses` now also returns the fully-resolved workflow (ordered
  statuses + legal transitions) so any client can compute a path;
  `scripts/specboard/sync-pr.sh` uses `--advance`.
- **Service (bot) accounts and resource-scoped API keys** (migration 0045). A
  new `service` member role models a machine account: a real user with no login
  plus a `service` membership, so automated activity is attributed to a labelled
  identity instead of a human. An owner creates one via the session-only `POST
/api/v1/org/service-accounts`, which mints a scoped key. API keys now carry
  `<resource>:<action>` scopes (`api_keys.scopes`); an empty scope list stays
  full-access, so existing keys are unaffected. Scope enforcement is centralized
  in the API authorization layer, with per-key rate limiting on `/api/v1`.
- **Public REST API completeness.** Filled the missing CRUD verbs (`GET
/products/:id`, `GET` + `PATCH /repositories/:id`, `PATCH /views/:id`); added
  opt-in, order-preserving cursor pagination (`?limit` / `?cursor`, exposing
  `nextCursor`) on the features, releases, ideas, and org-members lists; and an
  OpenAPI 3 document at `GET /api/v1/openapi.json`.
- **CLI distribution.** `@specboard/cli` is now publishable to npm (public,
  self-contained) via a `cli-v*` tag-triggered workflow, with a Homebrew formula
  source under `packaging/homebrew/`.
- **Reusable Specboard-sync workflow.**
  `.github/workflows/specboard-sync-reusable.yml` lets any repo enable the loop
  with a ~5-line caller that runs the published CLI, instead of copying the
  workflow plus `scripts/specboard/*`.

Migration 0045 (`member_role += service`, `api_keys.scopes`), applied to test
and production.

## [0.20.0] - 2026-07-20

Backlog grooming UX plus a release-management addition.

### Added

- **RICE prioritization scoring** (migration 0044). Features carry dedicated
  Reach / Impact / Confidence / Effort inputs with an app-computed RICE score,
  an item-detail editor with a live score, a `?sort=rice` order on the list and
  board, and a score badge on board cards.
- **Bulk operations on the backlog.** An opt-in multi-select mode (a "Select"
  toggle) on the board and list applies one change (status, assignee, release,
  add or clear tags) across many items via `POST /api/v1/features/bulk`, each
  item in its own transaction with per-item results.
- **Command palette (Cmd/Ctrl-K).** Keyboard-driven navigation built on a shared
  nav model the sidebar also consumes. Navigation-only in this release; item
  search and quick actions are a follow-on.
- **Filter bar on the board view** (#50). The list view's URL-driven filters now
  render on the board too; a status filter collapses the board to that column.
- **Actual ship dates on releases** (migration 0043). A release stamps its real
  ship date when first shipped (existing shipped releases backfilled from their
  target date) and clears it on reopen; the Shipped roadmap view orders
  newest-shipped first.

Migrations 0043 (release shipped date) and 0044 (RICE columns), applied to test
and production.

## [0.19.0] - 2026-07-16

### Added

- **Product groups.** A workspace can now collect products into nested groups
  (up to 4 levels), managed from Settings -> Products. A group appears in the
  product switcher and scopes the Backlog, Roadmap, and Ideas to its whole
  subtree via a `~{group}` URL segment, with per-product badges on cards. A new
  group Dashboard rolls the subtree up for management: item counts, stacked
  status bars, per-subgroup aggregate cards, and per-release done/total
  progress, computed only over products the viewer can read. New tables and
  policies land in migration 0039 (`product_groups`, `products.group_id`, RLS:
  member read, org-admin write); the API adds `/api/v1/product-groups` (CRUD)
  and `/:id/summary`.
- **Product groups over MCP.** Both MCP surfaces (the `/api/mcp` endpoint and
  the stdio server) gain `list_product_groups`, a `group` filter on item
  listing, and a `group` key on `list_products`; the HTTP server also adds
  `group_summary` so management roll-ups can be pulled programmatically.
- **Explicit repo -> product links.** Repositories can now be linked to one or
  more products (microservices feeding one product, or a monorepo feeding
  several), with a per-repo default product that sync assigns newly discovered
  specs to instead of the workspace default. Managed inline on each repo row
  under Settings -> Integrations -> Repositories (chips + a star on the
  default), backed by `PUT /api/v1/repositories/:id/products`. Migration 0040
  adds `product_repositories` with a DB-enforced single default per repo and
  backfills every existing repo to its workspace's default product, so sync
  behavior is unchanged until links are edited. Deployments using the
  `specboard_worker` role must re-run `infra/worker-role.sql` (new SELECT
  grant) per the role-cutover runbook.
- **Configurable cards on the Roadmap.** The Roadmap gets the same "Card fields"
  menu as the Backlog board, so you can choose which fields (assignee, tags,
  custom properties, etc.) show on release cards and which custom field is
  featured. Each space keeps its own selection: a new `board` discriminator on
  `board_preferences` (migration 0038) stores the Backlog's and Roadmap's card
  fields independently, so changing one leaves the other untouched. Existing
  saved preferences carry over as the Backlog's.

- **Invite-only pre-release access.** A public `POST /api/access-request`
  endpoint (validation, honeypot, per-IP throttle, CORS-locked to the marketing
  origins) takes access requests from the marketing site, emailing the review
  inbox and a confirmation to the requester via the existing Postmark service
  (from `no-reply@specboard.ai`). A new `SPECBOARD_INVITE_ONLY` flag closes
  public sign-up: only an email with a live pending org invitation can create an
  account, so the existing approve-by-invitation flow is the way in. Off by
  default (self-host keeps open sign-up).

### Changed

- **README rewritten to lead with the value proposition, "why Specboard",
  features, and quick start** before the repo layout, so new users understand
  what they're getting before diving into internals.
- **Commercial/licensing contact unified to `contact@specboard.net`** across the
  README and `LICENSING.md` (retiring `contact@palouse.io`). "Studio Palouse"
  stays as the parent-company name, and Specboard is now noted as a member of
  the Studio Palouse family of apps.

### Security

- **CSP `style-src` no longer allows `'unsafe-inline'`.** The style-src element
  directive now carries only `'self'` plus the per-request nonce, so an injected
  `<style>` block is refused; inline `style` attributes move to the narrower
  `style-src-attr`. sonner's un-nonced runtime style injection is patched out in
  favour of a static CSS import.
- **Outbox/webhook workers run on a dedicated non-owner DB role.** The outbox
  delivery drainer + relay and the incoming GitHub webhook sink no longer use
  the owner connection (which bypasses RLS); they connect as a narrow
  `specboard_worker` role scoped to just the tables they touch, with
  role-targeted RLS policies for their cross-workspace access. Provisioned and
  activated on test + prod via `DATABASE_URL_WORKER` (`infra/worker-role.sql`).
- **Tenant data served over the RLS-enforced non-owner connection.** The
  `specboard_app` role + `DATABASE_URL_APP` are live on both environments, so
  row-level security is a real database backstop behind the app's `workspaceId`
  filters rather than a bypassed owner connection.
- **Operator runbooks** for the RLS non-owner cutover, the worker-role cutover,
  the out-of-app webhook egress policy, and the GitHub install-bind smoke test
  (`docs/RUNBOOK-db-role-cutover.md`, `docs/RUNBOOK-webhook-egress-policy.md`,
  `docs/RUNBOOK-github-install-bind-smoke-test.md`).

### Fixed

- **Connecting a repository no longer bounces to the backlog.** The Integrations
  page built the GitHub install link with the App slug in the `?org=` parameter
  instead of the workspace slug, so membership resolution failed and redirected
  to the board. It now uses the workspace slug.
- **GitHub App installs on an organization now complete.** The install-bind
  ownership check reads the installer's org membership, which needs the App's
  Organization Members (read) permission; the App requested only repository
  permissions, so org installs failed with "The installation didn't complete."
  The App manifest now requests `members: read`.

## [0.18.3] - 2026-07-13

### Changed

- **Sidebar shows the two-tone "Specboard" wordmark** (Spec in foreground,
  board muted) next to the brand mark, replacing the mark-only header.

### Added

- **Collapsible left navigation.** A toggle collapses the sidebar to an icon
  rail (just the brand tile mark plus the area icons, with hover tooltips) and
  expands it back to the full wordmark + labels. The choice persists per browser
  (`localStorage`). Collapsed, the profile footer shows the avatar only.

## [0.18.2] - 2026-07-13

### Changed

- **New brand mark ("Slotted S") across all app icons.** Regenerated the
  favicon, app icon, Apple touch icon, OpenGraph image, and the in-app sidebar /
  auth / OAuth-consent mark (`public/brand/specboard-mark.png`) from the Gesso
  design system: a green rounded tile with a white "S" built from three board
  lanes and two offset connectors (the faded middle lane nods to "in progress").

## [0.18.1] - 2026-07-13

### Changed

- **Roadmap releases now lay out as horizontal, laterally-scrolling columns**
  instead of a wrapping grid that stacked them down the page. Matches the status
  Board's kanban idiom (fixed-width columns, `overflow-x` scroll), so adding a
  release pushes the row sideways rather than reflowing onto new rows.

## [0.18.0] - 2026-07-13

Expose releases through the MCP server so agents can organize the backlog into
versions, and consolidate the repo's implementation docs into Specboard itself.

### Added

- **`list_releases` and `create_release` MCP tools.** Agents can now read a
  workspace's releases (id, name, status, start/target dates, notes, item count)
  and create new ones, then schedule work into a release via
  `update_item(releaseId)`. `create_release` is owner-only, mirroring the
  admin-gated `POST /api/v1/releases` route; both are thin adapters over the same
  service layer the REST API uses, so authorization and validation are identical.

### Changed

- **README refreshed for how the app works today.** Documents the hosted
  `/api/mcp` OAuth 2.1 endpoint as the primary way agents connect (with the
  current tool set) alongside the local stdio server, and clarifies that agents
  edit spec content over MCP (committing to git) while the in-app spec editor is
  still stubbed.
- **Implementation docs consolidated into Specboard.** The product and platform
  backlog now lives in the Specboard workspace; shipped and migrated planning
  docs moved to `docs/archive/`, and `docs/BACKLOG.md` is now a pointer.

## [0.17.0] - 2026-07-12

Make browser sign-in the reliable way to connect an MCP client. The OAuth
consent screen now scopes a connection to the right identity and workspace, so
users no longer need a manual `x-org-slug` header or API key just to connect.

### Added

- **Workspace picker on the MCP consent screen.** A user who belongs to more
  than one workspace picks which one a connection targets when they approve it.
  The choice is stored per connection (keyed by user and OAuth client) and the
  hosted MCP endpoint reads it when no explicit `x-org-slug` header is present.
  An explicit header still wins, so one client can be pointed at two workspaces
  from two configs. Membership is re-validated on every request, so a binding to
  a workspace the user has left fails closed rather than granting access.

### Changed

- **The MCP consent screen confirms who you are.** It now shows "Signed in as
  {email}" with a "Not you? Switch account" link, so the account a connection
  binds to is a deliberate confirmation rather than easy-to-miss fine print.
- **A workspace-less account can no longer complete MCP consent.** If the
  signed-in account belongs to no workspace, the screen prompts you to switch
  accounts instead of minting a token that fails every later call with "you do
  not belong to a workspace."

## [0.16.0] - 2026-07-12

Administrative polish surfaced while dogfooding Specboard on Specboard, plus a
new MCP tool.

### Added

- **`delete_item` MCP tool.** Coding agents can now delete a DB-native card
  (initiative/epic/feature) through the hosted MCP, not just create and update.
  It wraps the same service path as the REST delete, so authorization, child
  re-parenting, relation cleanup, and webhook emission are identical.
  Spec-backed items are rejected (they are deleted in git).

### Changed

- **Creating a product now makes you its admin.** The person who creates a
  product is recorded as an explicit product admin, so they appear in the
  product's member list and keep that standing even if later demoted from org
  admin.
- **Repository management moved under Settings - Integrations.** Connected
  repositories are now a fourth tab (alongside MCP, API keys, and Webhooks)
  rather than a separate settings page, since a repository connection is a type
  of integration. The old `/settings/repositories` route redirects, preserving
  the GitHub install/callback banners.

## [0.15.0] - 2026-07-11

Security hardening batch from the July 2026 adversarial source review (see
`docs/archive/security-fixes.md`). No new product features; these close the P0-P2
findings.

### Changed

- **API requests now scope to an explicit, validated organization.** Requests
  carry the active org as an `x-org-slug` header (the browser derives it from
  the `/{org}/` route; the CLI reads `SPECBOARD_ORG` / `--org`), validated
  against a real membership. The old "resolve the caller's oldest membership"
  fallback is gone: a user in more than one org can no longer have a request
  silently resolve to the wrong tenant, and an ambiguous call is rejected.
  Single-org and self-host callers are unaffected.
- **Content-Security-Policy is now nonce-based.** `script-src` uses a
  per-request nonce with `strict-dynamic` and no longer allows
  `'unsafe-inline'`, so injected inline scripts are refused.
- **Auth rate limits are database-backed** (was in-process memory), so they
  hold consistently across instances.

### Fixed

- **GitHub App installation binding requires proof of account ownership.** The
  install flow now runs an OAuth identity step and binds an installation only
  when the signed-in user owns the personal account or is an active admin of
  the organization it belongs to, closing a takeover where a workspace owner
  could bind another tenant's installation. Requires `GITHUB_APP_CLIENT_ID` /
  `GITHUB_APP_CLIENT_SECRET` (hosted) or the in-app manifest flow (self-host).
- **Database tenant isolation fails closed.** The hosted app refuses to serve
  tenant data over an RLS-bypassing connection and verifies at boot that its
  tenant-data role is non-owner, non-superuser, without `BYPASSRLS`.
- **Webhook SSRF guard hardened** against DNS rebinding (the connection is
  pinned to the pre-validated address) and against IPv4-mapped/hex IPv6 forms
  (now judged with a maintained range parser).
- **Request bounds and quotas.** Body-size limits on the MCP and GitHub webhook
  routes, a JSON-RPC batch cap, and per-workspace quotas on expensive
  operations (repo scan/import/starter-spec/connect, webhook test sends).
- Structured `[security:*]` telemetry for rate-limit rejections, oversized
  requests, and invalid GitHub webhook signatures.

Migrations 0035 (GitHub install ownership) and 0036 (rate-limit tables),
applied to test and production.

## [0.14.0] - 2026-07-08

### Changed

- **Consolidated roles into a clear two-layer model** (migration 0034). The
  workspace has one admin role, **Owner** (rename the org, manage products and
  their relationships, manage members, and admin of every product); everyone
  else is a **Member** (read-only at the org, so they still see the
  cross-product rollups). Real capability is granted **per product**: **Admin**
  (manage that product's config + members, and edit it), **Contributor** (edit
  that product's items), or **Viewer** (read it). This replaces the old org
  roles (admin/pm/ux/eng/viewer) and product roles (admin/editor/viewer):
  `admin`→`owner`, pm/ux/eng→`member`, product `editor`→`contributor`. Existing
  per-product grants are preserved, so no one loses edit access. Write
  permission is now enforced per product end to end (web, REST, and MCP);
  `whoami` reports the caller's per-product access.

### Added

- **Invitations grant product access.** A single invite chooses Owner or Member,
  and a Member invite can grant access to several products at once (Admin /
  Contributor / Viewer per product), all applied atomically when the invite is
  accepted.

## [0.13.0] - 2026-07-08

### Added

- **Organization user management** (Settings → Company & Team; migration 0033
  adds the `invitations` table and a `members.deactivated_at` column). Admins
  now get a real team roster: change a member's org role, remove a member, or
  deactivate/reactivate them, all protected by a last-admin guard so the only
  admin can't be demoted, removed, or suspended.
- **Email invitations.** An admin invites a teammate by email with a chosen
  role; the invitee gets a signed `/invite/<token>` link (7-day expiry, hashed
  token stored, strict email match on accept), signs up or in, and joins the org
  automatically at the invited role. This is what makes a hosted, multi-tenant
  org usable by more than its founder. Pending invitations can be re-sent or
  revoked.
- **Member deactivation.** A suspended membership is denied everywhere at once
  (web pages, REST API, API keys, and MCP) via a single membership choke-point,
  without deleting the user. Deactivation is per-organization, so the same
  account can stay active in another org.

## [0.12.0] - 2026-07-07

### Added

- **Hosted MCP endpoint for AI agents** (`/api/mcp`). Coding agents (Claude
  Code, Claude Desktop, claude.ai) connect to a single Streamable-HTTP endpoint
  that exposes the backlog and git-backed specs through nine tools: read the
  hierarchy and items, edit metadata and DB-native card bodies, commit spec
  Markdown to the connected repo, and break a card down into child specs. Tools
  call the same service layer as the REST API, so auth, the status workflow,
  stage gates, and webhooks all match the web app. One endpoint serves both
  self-host and the hosted SaaS.
- **OAuth 2.1 sign-in for MCP** (migration 0032 adds `oauth_applications`,
  `oauth_access_tokens`, and `oauth_consents`). Adding the endpoint URL is
  enough: the client discovers the authorization server, registers itself
  (Dynamic Client Registration), and walks the user through sign-in and a
  consent screen in the browser; the agent then acts as that user and inherits
  their workspace role. PKCE is required for every client, every authorization
  is confirmed on an explicit consent screen, and loopback redirects follow
  RFC 8252 (any ephemeral port on `localhost`). A personal API key
  (`Authorization: Bearer sb_...`) remains the non-interactive alternative for
  CI.
- **Integrations settings** (Settings → Integrations), a tabbed view for MCP,
  API keys, and Webhooks, with an MCP connect panel that shows this
  deployment's endpoint URL and copy-paste setup for Claude Code and Claude
  Desktop.

## [0.11.0] - 2026-07-05

### Added

- **Plan / Build / Ship navigation with Strategy, Research, and Architecture
  areas** (migration 0030 adds `doc_spaces` and `doc_pages`). The sidebar groups
  work into Plan / Build / Ship sections and adds document areas that can hold
  Specboard-native rich-text pages or link out to an external source, with a
  source chooser per area.
- **GitHub-backed doc repositories** for the Research and Architecture areas. An
  admin can create a private org repo from the source chooser; the area then
  renders that repo's Markdown tree, and an explicit Save commits edits straight
  to the default branch. The docs repo is kept separate from spec sync.
- **Webhooks delivery log + manual redeliver** (Settings → Webhooks). Each
  endpoint expands to its recent deliveries (event, status, attempts, HTTP
  result, last error, time). A per-row **Redeliver** re-queues the stored
  envelope for an immediate resend, re-sending the original delivery id and
  signature so consumers can dedupe.

### Changed

- **Webhooks: auto-disable an endpoint after repeated failures** (migration 0031
  adds `webhook_endpoints.consecutive_failures`). A run of deliveries that give
  up (retry budget exhausted, or a blocked URL) disables the endpoint after the
  fifth consecutive failure, shown as **Auto-disabled** in the UI; any success or
  a manual Resume clears the streak. Stops a dead endpoint from generating doomed
  retry traffic.
- **Roadmap polish.** Selecting a card opens the same in-context preview panel as
  the Backlog board (instead of a full-page navigation); the release detail panel
  shows a proper title clear of the close button; columns without dates keep their
  cards aligned with dated columns; and the release **Release** action is now a
  primary button so it stands out from **Edit**.

## [0.10.1] - 2026-07-05

### Changed

- **Webhooks: durable transactional outbox** (migration 0029 adds
  `outbox_events`). Domain changes now record their event in the _same database
  transaction_ as the change, closing the small window where a crash between the
  commit and the webhook enqueue could drop an event. A relay fans events out to
  the per-endpoint delivery queue and the drainer sends them as before, so
  delivery behavior is unchanged. The `outbox_events` stream is generic, so
  future consumers (notifications, an activity feed) can build on it. Processed
  events are pruned on a retention window (`SPECBOARD_OUTBOX_RETENTION_DAYS`,
  default 7) so the table doesn't grow without bound. No user-facing change.

## [0.10.0] - 2026-07-05

### Added

- **Outbound webhooks** (Settings → Webhooks, admin-only; migration 0028 adds
  `webhook_endpoints` and `webhook_deliveries`). Register HTTPS endpoints that
  receive a signed POST when items and releases change. Four events:
  `item.status_changed`, `item.created`, `item.deleted`, and `release.shipped`.
  Endpoints route per product (or workspace-wide) and subscribe to a chosen set
  of events. Delivery is durable: each event is written to a transactional
  outbox and an in-process drainer POSTs it with retries and exponential backoff
  (1m, 5m, 30m, 2h, 6h). Every request is signed Stripe-style
  (HMAC-SHA256 over the timestamp and body, sent as `X-Specboard-Signature`); the
  per-endpoint signing secret is generated server-side, encrypted at rest, and
  shown to the admin once. A "send test event" button delivers a sample payload
  and reports the result. Outbound URLs are SSRF-guarded (https only; private,
  loopback, link-local, and cloud-metadata targets are blocked), with an env
  opt-out for self-hosted installs. Webhooks require a database (off in local
  file mode).

## [0.9.0] - 2026-07-05

### Added

- **Roadmap: drag to schedule.** The Roadmap is now an interactive board.
  Editors drag a card into another release column to set its release (or into
  Unscheduled to clear it); the drop is optimistic, persists the release, then
  revalidates. Read-only viewers and the shipped view stay static.
- **Release detail panel with notes.** Clicking a release name opens a drawer
  showing its status, dates, item count, and Markdown notes (migration 0027
  adds a nullable `notes` column to `releases`). The Release / Reopen, Edit, and
  Delete actions now live in this panel instead of crowding the column heading,
  and editing happens inline there.
- **Ideas detail drawer.** Clicking an idea opens a full detail view (Markdown
  details, vote, and, for editors, edit / promote / delete) mirroring the
  feature flyout. Promote and Delete moved off the list row and into the drawer.

### Changed

- **Ideas: status is a distinct field.** The review-stage control on each idea
  row is now a low-chrome status pill (colored dot, label, chevron) rather than
  a button that looked like Promote. The list gains a status filter and a
  votes / newest / oldest sort.
- **Roadmap column heading.** The release name sits on its own line with the
  dates (and any non-default status) smaller beneath it, instead of a single
  crowded line of look-alike controls.

## [0.8.0] - 2026-07-04

### Added

- **Ideas (internal view)** (new "Ideas" area in the sidebar, per product;
  migration 0026 adds `ideas`, `idea_votes`, `idea_statuses`, and
  `idea_settings`). Teams can capture feature requests / feedback, vote on them
  (a demand signal that sorts the list), move each through a configurable review
  workflow (New → Under review → Planned → Shipped → Parked → Declined by
  default), and **promote** a worthwhile idea into a feature: promotion creates a
  DB-native item at the planning level, links it back to the idea, and advances
  the idea's status. Ideas are product-scoped with the same visibility rules as
  features; voting is open to any member, while editing/promoting/deleting follow
  the product write roles.
- **Settings → Ideas.** Admins configure the idea **review stages** (rename in
  place, reorder, add, remove; removing a stage re-homes its ideas to the first)
  and the **public portal** settings (publish toggle + portal heading). The
  public, unauthenticated voting portal built on this data is a planned
  follow-up; its configuration ships now.

## [0.7.0] - 2026-07-04

### Added

- **Workflow stage gates** (Settings → Cards → Workflow → Stage gates; migration
  0025 adds `workspace_stage_gates` and `feature_gate_completions`). Admins can
  attach a checklist to any stage. An item sitting in that stage shows the
  checklist on its detail view, and members tick items off as they go. A stage's
  checklist must be fully complete before the item can advance forward: the move
  is hard-blocked on the board and through the API until every gate is checked.
  Pulling an item back to an earlier stage or archiving it is always allowed. A
  multi-stage jump enforces the checklists of every stage it passes over, so
  gates can't be skipped by jumping. The MCP server's `update_status` enforces
  the same rule, so coding agents can't advance an item past its checklist.
  Renaming a stage keeps its gates; removing a stage clears them.

## [0.6.0] - 2026-07-04

### Added

- **Custom workflow stages** (Settings → Cards → Workflow; migration 0024 adds
  `workspace_statuses`). Admins can rename a stage in place (its key, and so its
  items, stay put), reorder, add, or remove stages; the board columns, status
  pickers, and transition validation all follow. Removing a stage re-homes its
  items to the first stage. The MCP server's status validation reads the same
  workflow. (Stage gates are a planned follow-up.)
- **URL field type** for custom properties, so items can link out to Figma,
  Miro, docs, etc. Rendered as a clickable link on the item, with an open-link
  affordance while editing.
- **Notion-style item detail.** Initiatives, epics, features, and work items now
  share one detail layout: the level, an inline-editable title, then a block of
  property rows (each with a type icon) for Status, Assignee, Release, Tags, and
  every custom property, followed by the rich-text body and the Relationships /
  Integrations sections.
- **Generate child items.** Each item has a "Generate {child level}" action that
  creates items one level down (Initiative → Epic, Epic → Feature, Feature →
  Work item) with the parent pre-selected; the drawer stays open to add several
  in a row. Manual today; an AI-assisted generator can slot in behind it later.
- The board **flyout is now resizable** (drag its left edge; the width is
  remembered) and renders the exact same layout as the full item page, backed by
  a new `GET /api/v1/features/:specId/context` endpoint.
- **Release lifecycle** on the Roadmap (migration 0023 adds `releases.start_date`):
  releases now carry a **start date** and a **ship date**, both editable after
  creation. A **Release** action marks a release shipped, which drops it and its
  items from the active roadmap (the assignment is kept for history) and moves it
  under a new **Shipped releases** view; shipped releases can be reopened from
  there.

### Changed

- **Board cards no longer carry a status dropdown** — the column already shows
  the stage, and dragging between columns is how the stage changes.
- **Card fields update live.** Toggling a field in the board's "Card fields" menu
  now updates the cards instantly (shared client state) instead of needing a
  page refresh.
- **Cards settings are grouped** into bordered panels — Workflow, Fields
  (built-in fields + custom properties), and Templates — so related controls
  read together.
- The item detail is retitled: the body sits under a **Description** heading with
  a roomier (~10-row) editor, and the **Relationships** and **Integrations**
  sections start collapsed until you expand them.
- The product attribution badge is now hidden when the workspace has only one
  product (it carried no information there), on both the board and the roadmap,
  in addition to the single-product view.
- Item bodies (and titles, for DB-native items) **auto-save** as you type; the
  manual "Save details" button is gone. Undo/redo use the editor's native
  history. Spec-backed bodies stay read-only (their source of truth is git).
- The flyout's "Open full spec" link is now an **Open fullscreen** expand
  control.
- On the Roadmap, the **Unscheduled column is hidden** when every item is
  assigned to a release.

### Fixed

- Newly entered item details no longer disappear after saving until a page
  reload. The editor previously remounted and reseeded from a stale value while
  `router.refresh()` was in flight; it now holds its content.

## [0.5.0] - 2026-07-03

### Added

- Card details are now first-class. Creating an initiative/epic/feature captures
  a **Details** body in a rich-text editor that stores Markdown behind the
  scenes, with a "Raw" toggle to edit the Markdown source directly. Details are
  shown and editable on the item page after creation (migration 0022 adds
  `features.details`).
- New-card creation also captures **Status** (defaults to the first stage in the
  workflow) and **Assigned To**, alongside the title.
- **Details Templates** (Settings → Cards): admins define reusable Markdown
  skeletons and assign a default template per hierarchy level, so new cards at
  that level start pre-filled. Ships with example templates to copy from.
- **Release editing** on the Roadmap: rename a release and change its status or
  target date inline, in addition to the existing create/delete.

### Changed

- The Roadmap and Backlog "New {level}" drawer now includes status, assignee,
  and the Details editor.

## [0.4.0] - 2026-07-03

### Added

- Custom properties, defined by admins in Settings → Cards (migration 0021):
  create a property with a label, a type (text, number, select, multi-select,
  date, or person), options where relevant, and the hierarchy levels it
  applies to. Values are edited on each item's page and the board drawer, and
  can be shown on board cards. Properties previously came from the repo's
  `.specboard/config.yml`; the database is now the single source and the
  `fields`/`estimate` config keys are ignored.
- Releases (migration 0021): a workspace-wide record with a name, status
  (planned/in progress/shipped), and optional target date. Items are
  scheduled into a release from their detail page or the board drawer. The
  Roadmap now groups items by release (dated releases first, "Unscheduled"
  last) and admins create or delete releases right from the Roadmap. The
  backlog list gains a release filter and a Release column.
- Item pages have a dedicated Relationships section combining the parent
  picker, the children list with roll-up progress, and the typed links
  (blocks/relates/duplicates), previously split between the metadata sidebar
  and a hierarchy block.

### Changed

- Cards start lean: every level now carries name, status, assignee, and tags
  only. The built-in priority, estimate, and roadmap quarter fields are
  removed (migration 0021 drops the columns; recreate any of them as custom
  properties if needed). Backlog ordering falls back to manual board rank,
  then title. The CLI's `priority` command is gone.
- The Backlog and Roadmap now open on the Feature level by default
  (previously the leaf Work Item level). The `?level=` switcher works as
  before.
- Per-level field availability (Settings → Cards) now covers the built-in
  assignee and tags fields; custom-property availability lives on the
  property itself. Existing per-level selections were reset to "all".

## [0.3.0] - 2026-07-03

### Added

- Settings → Cards (renamed from "Work cards"): admins choose which metadata
  fields (priority, estimate, assignee, roadmap quarter, tags, and custom
  fields) are available at each hierarchy level. Levels with no restriction
  automatically pick up new custom fields. Stored per level (migration 0020)
  and enforced in the metadata form on the item page and the board drawer.
- The workspace's dedicated spec repository (created by the one-click
  onboarding flow) is now marked as such (migration 0020) and shown with a
  "(spec repo)" tag.

### Changed

- Work item details are organized into three collapsible sections: Metadata,
  Details (the spec content), and Integrations (GitHub links). Collapsed or
  expanded state is remembered between sessions. The board's edit drawer uses
  the same Metadata and Integrations sections.
- Metadata on cards now saves automatically: selects commit on change and
  text fields when you pause or leave them. The "Save metadata" button is
  gone; a subtle Saving/Saved indicator replaces it.
- The guided "create your first spec" walkthrough now targets the dedicated
  spec repo by default (previously it defaulted to the first connected
  repository, which could silently commit the starter spec into an
  application repo), lists the spec repo first in the picker, and names the
  repository it committed to in the confirmation.
- The "Prefer a dedicated repo just for specs?" instructions disappear from
  the first-spec walkthrough once a dedicated spec repo exists.

### Fixed

- Saving metadata on cards no longer fails with a 500 on hosted deployments:
  the app's row-level-security database role was missing SELECT on `users`,
  which the assignee validation introduced in 0.2.0 reads. (Database grant,
  applied to both test and production.)

## [0.2.2] - 2026-07-03

### Fixed

- Signing up with an email that already has an account now sends that address
  a "you already have an account" email pointing at sign-in and password
  reset. Previously the attempt was answered with a generic success (correct,
  it prevents account enumeration) but nothing was delivered, so the
  legitimate owner waited for a verification email that never came. The
  "Check your email" notice copy no longer promises a verification link
  specifically.
- Auth rate limiting now resolves the real client IP from Fly's
  `Fly-Client-IP` header. Behind Fly's proxy it previously fell back to a
  single shared per-path bucket for all visitors, so a handful of sign-in
  attempts from anyone could rate-limit everyone.

## [0.2.1] - 2026-07-03

### Changed

- Dark mode now carries a deep blue tint instead of neutral gray, aligning
  the theme with the Specboard brand. Surface lightness is unchanged, so
  contrast is unaffected.

## [0.2.0] - 2026-07-03

### Added

- One-click dedicated spec repo creation during onboarding: for organization
  installations, Specboard creates a private repo, connects it, and hands off
  to the first-spec walkthrough to seed it. Requires the GitHub App's
  repository Administration (write) permission; the self-host manifest now
  requests it, and hosted Apps need it added in GitHub. Personal-account
  installations keep the manual deep-link steps.
- The connect picker's repository list is prefetched server-side, so it
  renders with the initial HTML instead of popping in after a client fetch;
  loading states now use skeletons.

### Changed

- GitHub App installations are persisted in a workspace-scoped
  `github_installations` table (migration 0019) instead of a 15-minute signed
  cookie, so the connect picker, repo creation, and repo connect work on any
  later visit. Multiple installations per workspace are supported, uninstall
  webhooks drop the binding, and stale rows self-heal on read.

### Security

- Hardened the app surface ahead of an external pen test: security headers
  (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy),
  Better Auth rate limiting with stricter credential-path rules, a non-root
  runtime container, and a CSRF nonce on the GitHub App install round-trip.
- Closed cross-tenant defense-in-depth gaps: webhooks reconcile every
  workspace that connected a repo, assignee and product-member targets are
  validated as workspace members, and changing a product's visibility is
  restricted to org admins.
- Sturdier input handling: malformed percent-escapes no longer 500 the site,
  an unparseable spec is skipped instead of aborting the repo sync, and the
  untrusted repo config's globs and statuses are bounded to limit ReDoS.
- Provisioned (not yet activated) a non-owner `specboard_app` database role
  for the row-level-security cutover.

## [0.1.6] - 2026-07-01

### Fixed

- Deployed apps served a broken logo image on the sign-in and sign-up cards:
  the Docker runtime image did not include the `public` folder, which Next.js
  standalone output requires to be copied in manually, so every public asset
  returned 404 in cloud environments.

## [0.1.5] - 2026-07-01

### Added

- App branding from the new logo kit: favicon, apple touch icon, and social
  preview (Open Graph) image, plus the icon mark in the sidebar header and on
  the sign-in and sign-up cards.
- First automated end-to-end tests: a Playwright suite covering the onboarding
  spec flow (scan and import, guided first spec, dedicated-repo nudge), run in
  CI on every pull request and now a required check on `main`.

### Changed

- Brand spelling unified to "Specboard" (previously "SpecBoard") across the UI,
  docs, and emails.
- Dependencies updated to latest compatible versions (better-auth 1.6.23,
  Tailwind 4.3.2, lucide-react 1.23, vitest 3.2, turbo 2.10, prettier 3.9).
  The vitest bump moves the transitive vite past two security advisories.

### Fixed

- Flaky end-to-end setup: signing in raced the app's own redirect to `/setup`.

## [0.1.4] - 2026-07-01

### Added

- Onboarding spec flow. Connecting a repository now registers it without
  auto-importing; an "Import your specs" panel scans connected repos read-only
  for `spec.md` files and creates cards only after you confirm, then links to the
  board.
- Guided first spec. When connected repos have no specs, the empty state walks
  you through naming a feature and picking a repo, then commits a starter
  `specs/<feature>/spec.md` (stable id and template body) and imports it so a
  real card appears. Refuses to overwrite an existing file.
- "Prefer a dedicated repo just for specs?" nudge for users without a suitable
  repo: a prefilled link to create a `specs` repo on GitHub, then install,
  connect, and seed it through the existing flow. No new GitHub App permissions.

## [0.1.3] - 2026-06-30

### Added

- CLI: `specboard --version` (also `version` / `-v`) prints the released
  version, read from the package manifest at runtime.
- `VERSIONING.md` documenting the single-version monorepo scheme and the
  per-release increment rule, plus this changelog.

### Fixed

- GitHub App install: a stray trailing space in the hand-configured "Setup URL"
  made GitHub redirect post-install to `/api/v1/github/setup%20`, a 404.
  Middleware now normalizes any trailing-whitespace variant back to the real
  route, preserving the `installation_id` / `setup_action` query, so the connect
  flow lands on the Repositories page instead of a dead end.

## [0.1.0]

- Initial baseline: spec backlog, roadmap, GitHub sync, multi-tenant org model,
  programmatic API keys, and the `specboard` CLI.
