# Specboards and the AI-native SDLC

Anthropic published [the AI-native SDLC
playbook](https://claude.com/blog/the-ai-native-sdlc-playbook), which argues
that code is no longer the bottleneck, and that once it stops being one the
constraint moves "to the steps to the left and right of the build phase". It
lays out six stages (Plan, Design, Build, Test, Deploy, Maintain) and the
version-controlled artifacts that carry work between them: `intent.md`,
`spec.md`, `plan.md`, `CLAUDE.md`.

We think that is the right diagnosis, and it happens to describe the problem
Specboards was built for: the steps to the left and right of the build phase.

## What this page is, and is not

**Compatible with, not dependent on.** You can run every stage of the playbook
without Specboards, and you can run Specboards without adopting any of it. The
mapping below exists because a shared vocabulary is more useful than a private
one, not because we require the vocabulary.

We did not write the playbook, we do not maintain it, and nothing here is an
endorsement by Anthropic of Specboards. If the playbook is revised, this page
gets out of date; the product does not.

The mapping is deliberately falsifiable. Every row says what we do *and* what we
do not, because a page that claimed we cover all six stages would be worth
nothing to a reader who is trying to decide something.

## The dividing line

The playbook's stages split cleanly into two kinds of thing, and the split is
the most useful part of it for understanding where we sit:

- **Inside the session.** Plan mode, `CLAUDE.md`, skills, hooks, worktrees,
  evals, the review passes. These are properties of the agent and its harness.
  They are not ours and we do not want them to be.
- **Outside the session, between sessions.** What is worth doing, in what order,
  who decided, what it depends on, what it ladders up to, what shipped. These
  persist across sessions and across people, and they are what a coding agent
  has no memory of.

Specboards is the second kind. An agent talks to us at the start of a session to
find out what to do, and at the end to say what it did.

## Stage by stage

### Plan

> "Ideas stop waiting for someone to write them up. Intent is captured once, in
> the originator's own words, as a version-controlled artifact."

**What we do.** The Ideas intake is where an intent lands from a person, a
customer request, or an agent. Promoting one creates the work item, and
`create_spec` commits the artifact into your repo, so it is version-controlled
from the first line rather than at the point someone remembers to file it. The
promotion decision is recorded on the item.

**What we do not.** Run the brainstorming session that produces the intent. The
playbook's Plan stage is a conversation between a person and Claude; we are
where its output goes. An agent doing that conversation writes back to us over
MCP when it is finished.

**Where the shapes differ.** The playbook has one artifact per change,
`intent.md`, living beside the code. We have a first-class Idea that is not yet
a spec, because the ideas worth rejecting outnumber the ones worth specifying
and we would rather not commit a file for each.

### Design

> "Requirements and design collapse into one session. Policy is applied while
> the spec is written, not discovered in a review weeks later."

**What we do.** `create_spec` and `update_spec_content` write
`specs/**/spec.md` and commit through the GitHub App, so a specification arrives
as a reviewable diff on a branch rather than as a field in a database. The
`defining` stage is an explicit statement that design is still open, and the
`ready` gate is the statement that it has closed. Every spec write is recorded
in an audit trail with the identity that made it.

**What we do not.** Hold the skills that constrain the spec. Brand, security,
compliance, and UX policy live in your agent's configuration, and applying them
while the spec is written is exactly the playbook's point. We store and version
the result; we do not shape it.

### Build

> "Nothing is implemented without an accepted plan. Institutional knowledge
> becomes files the agent reads."

**What we do.** The status workflow is the accepted-plan boundary made
enforceable: an item is not picked up before `ready`, and the workflow is
validated rather than advisory, so an agent cannot skip a stage by accident. The
transitions are ordered, and moving several stages at once is an explicit
`advance` rather than something that happens quietly. Typed dependencies say
what is blocked by what, and the Initiative to Epic to Feature hierarchy says
what a change belongs to.

**What we do not.** Plan mode, `plan.md`, `CLAUDE.md`, worktrees, parallel
sessions, and the coding session itself. We are what the session reads at the
start and writes at the end. If several sessions run in parallel, what stops
them colliding is that they share one board with one status per item, which is a
weaker guarantee than a worktree and a different kind of thing.

### Test

> "Every session checks its own work before a human sees it, and the
> configuration that steers the agent gets regression-tested like the code."

**What we do.** Nothing. Your CI does this.

The only honest thing to say here is that the outcome shows up on the board
through linked PR state, so an item in `in_review` whose checks are failing is
visible without leaving the backlog. That is reporting, not testing.

We say this plainly rather than stretching for a claim, because a reader who
catches one stretched row stops believing the other five.

### Deploy

> "Review runs in both directions, and governance is enforced as the agent acts.
> The agent does everything up to the production gate."

**What we do.** `link_github` records the pull request, issue, or branch on the
item, and connected repositories reconcile live state back onto the board on
every push, so the board reflects what GitHub actually says rather than what
someone last typed.

The governance surface is the part that matters here. Agents get their own
identities rather than borrowing a person's, keys are scoped per resource
(`<resource>:read` / `<resource>:write`), requests and writes are quota'd, and
spec writes are audited. A workspace can see what each agent did and revoke one
without touching anybody else.

**What we do not.** The review passes themselves. `REVIEW.md`, the severity
ranking, and addressing comments on a pull request are the agent's work in your
repository.

### Maintain

> "The loop closes. A trigger invokes Claude with no person in the invocation
> path, and what it finds re-enters the pipeline."

**What we do.** An unattended agent identity holding a bearer key is precisely
the "no person in the invocation path" shape, and it is a first-class thing to
create rather than a service account someone improvises. What such an agent
finds is written back as an idea or a work item, which is the re-entry the
playbook describes: the loop closes into the same backlog people work from,
not into a separate incident queue.

**What we do not.** The trigger. Watching production, the control bands, the
statistical detection: none of that is ours, and the playbook is right that it
should stay deterministic with no model in the path. We are the destination and
the identity, not the watcher.

## Summary

| Stage | Specboards |
| --- | --- |
| Plan | Substantially. Intake, promotion, and the committed artifact. |
| Design | Substantially. Spec authoring, commit, review-as-diff, and the gate. |
| Build | Partly. The accepted-plan boundary and the dependency graph, not the session. |
| Test | Not at all. We report the outcome. |
| Deploy | Partly. Live PR state and the governance surface, not the review. |
| Maintain | Partly. The identity and the re-entry point, not the trigger. |

Three of six are partial and one is nothing. That is the accurate picture of a
tool that sits between sessions rather than inside them.

## Related

- [`README.md`](../README.md) has the short version of this mapping.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) covers the system-of-record split
  between git and the database that makes spec-as-diff possible.
- The MCP tool list, which is the concrete surface every claim above rests on,
  is in [`README.md`](../README.md#mcp-for-ai-agents).
