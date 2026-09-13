# The public portal

A page your customers can reach with no account: browse your ideas, vote on
them, suggest new ones, and (optionally) see your roadmap.

It is off by default, and switching it on is deliberately not enough to publish
anything. Every list starts empty, so a portal you enable and then forget about
shows nothing rather than showing everything.

---

## What visitors see

| Surface | URL | Gated by |
| --- | --- | --- |
| Ideas | `/{org}/ideas` | the portal switch, plus at least one product and one stage |
| One idea | `/{org}/ideas/{id}` | the same, plus that idea being published |
| Roadmap | `/{org}/roadmap` | its **own** switch, plus at least one item status |

`{org}` is your workspace slug, the same one in your own URLs. The portal is
served from the app's own domain rather than a subdomain, so it works on a
self-host with no wildcard DNS or certificate.

## Turning it on

**Settings -> Ideas -> the public portal.** Four decisions, in the order the
screen asks them.

1. **Publish the portal.** The outer switch. Off means every portal URL 404s,
   and it does so identically to a workspace that does not exist, so the URL is
   not a directory of who has an account.
2. **Products on the portal.** Only these products' ideas appear. Nothing is
   published until you pick at least one, and an unpicked product's *name* is
   never sent to a visitor either.
3. **Idea stages to show.** Which of your review stages are fit for outsiders to
   read. A stage you do not pick is invisible, and so is its label: if you have
   a stage called "Blocked on the Acme deal", nobody outside sees the phrase.
4. **Public submissions.** Whether a submitted idea waits for you or appears at
   once. See below.

The roadmap has a **separate** switch, because wanting feedback in the open is
not the same decision as publishing what you plan to build and when.

## Submissions and moderation

Anyone can suggest an idea from the portal. They give a title, optionally some
detail and their name, and an email address (required: it is how they get told
what happened, and how you can tell a stranger's suggestion from your own team's
capture on your board).

Two modes:

- **Wait for review** (the default). The idea lands on your Ideas board marked
  *Awaiting review* and is invisible to the public until you publish it. A
  banner at the top of the board tells you how many are waiting.
- **Publish immediately.** It appears on the portal at once, and you can hide it
  afterwards.

Every external submission is tagged **From the portal** on your board, with the
submitter's name where they gave one. Their email address is never shown
publicly.

> **A gotcha worth knowing about "publish immediately".** A submission arrives at
> the **first stage** of your review workflow, because nobody has triaged it yet.
> If you do not also publish that first stage (most workspaces publish `Planned`
> and `Shipped`, not `New`), the idea has permission to be public but nothing to
> be public *in*, so it still will not appear until you move it along. The
> settings screen warns you when your two choices combine that way, and names the
> stage to add.

Publishing, hiding and rejecting are all in the idea's drawer on your board,
alongside Edit, Promote and Delete. Hiding an idea takes it off the portal
immediately, including any link somebody already has.

## Voting

A visitor votes by entering an email address and opening the link we send them.
That is a deliberate trade: it costs a round trip, and it buys a demand signal
worth acting on rather than a number anybody can inflate.

- The link works for **30 minutes**. Opening it counts the vote.
- Opening it again does not count a second one.
- After the first confirmation, a cookie remembers them for **30 days**, so
  later votes on your portal are one click. It is scoped to your workspace: a
  confirmation given to you does not identify them anywhere else.
- One vote per person per idea. A member voting from inside the app and an
  outsider voting from the portal are counted separately and each once.

**Voting needs email to be configured.** With no mail transport the portal says
voting is unavailable rather than accepting an address and silently dropping the
message. See the mail settings in Settings -> Notifications.

## The roadmap

Releases and the work scheduled into them, in two sections: what is coming
(soonest first) and what has shipped (most recent first).

Items show a title, its level, and a **coarse phase**: Planned, In progress, or
Shipped. That is not your stage name. Internal workflow vocabulary is frequently
unflattering in public (`blocked`, `in_review`, `waiting_on_legal`), so the
portal maps your stages onto three neutral words by their position in your
workflow. Your own names are never sent to a visitor.

What is deliberately **not** on the roadmap: assignees, RICE scores, custom
fields, tags, child counts, and anything not scheduled into a release.

## What is never published

Worth stating plainly, because the point of the portal is that this list is
short and fixed:

- Which member captured an idea.
- The backlog item an idea was promoted into, including its title.
- Any submitter's or voter's email address.
- Any product you have not published, including its name.
- Any review stage you have not published, including its label.
- Any idea that is awaiting review or hidden.
- Any internal workflow stage name, anywhere.

Two independent things enforce this. The read models select only the fields
above, and the database connection the portal reads on carries row-level
security policies that refuse the rest, so a mistake in either is caught by the
other. Some of it is enforced at the level of the database *grant*: the portal's
role cannot read the `voter_email` column or a stage's `label` at all, so a
future bug cannot select what it never had permission to.

## Self-hosting

The portal needs one extra database role, `specboards_portal`, and one extra
connection string, `DATABASE_URL_PORTAL`. Without them every portal URL 404s and
nothing else is affected: the portal is opt-in and a deployment without one is
not degraded.

Provisioning is one script, run once per database. See
[RUNBOOK-db-role-cutover.md](./RUNBOOK-db-role-cutover.md), Part 3.

There is deliberately no fallback to the ordinary application connection. That
connection bypasses row-level security, and running a page served to strangers
on it is not a bargain worth making to save a setup step.
