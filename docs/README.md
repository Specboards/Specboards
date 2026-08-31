# Documentation

Grouped by who needs it. If you are evaluating or self-hosting Specboards, the
first section is the only one written for you; the runbooks below it are how we
operate our own hosted instance and will mostly not apply.

The two documents most people want are not in here: [`README.md`](../README.md)
at the repo root for what Specboards is and how to install it, and
[`ARCHITECTURE.md`](../ARCHITECTURE.md) for how it is put together.

## Running it yourself

- [`SECURITY-self-host-checklist.md`](./SECURITY-self-host-checklist.md) - what
  to lock down before putting a self-hosted instance in front of anyone. Start
  here; the rest of this section assumes you have.
- [`GUIDE-self-hosted-model.md`](./GUIDE-self-hosted-model.md) - pointing
  Specboards at your own model, for deployments that cannot send a spec to a
  public API.
- [`AGPL-source-availability.md`](./AGPL-source-availability.md) - what AGPLv3
  section 13 obliges you to offer your users, and how we satisfy it.
- [`RUNBOOK-github-sync.md`](./RUNBOOK-github-sync.md) - connecting a repository
  so Specboards imports its specs and stays in sync on every push. Written for
  our instance, but the mechanism is the same on yours.
- [`GUIDE-webhooks.md`](./GUIDE-webhooks.md) - the outbound webhook contract:
  the envelope, every event payload, how to verify the signature, and what
  delivery guarantees. Written for whoever builds the receiver.

## Why the system is the way it is

Architecture decision records. These describe decisions we still live with, so
they are worth reading before changing the areas they cover.

- [`adr/0001`](./adr/0001-multi-tenancy-url-and-product-grouping.md) -
  multi-tenancy, URL tenancy, and products as database groupings.
- [`adr/0002`](./adr/0002-work-item-leaf-and-typed-item-urls.md) - the Work Item
  leaf level and typed item URLs.
- [`adr/0003`](./adr/0003-spec-as-attachment.md) - a spec is an attachment to a
  work item, not an identity of its own.
- [`adr/0004`](./adr/0004-mcp-connection-auth.md) - how an MCP client
  authenticates, which identity it acts as, and which workspace it binds to.
- [`AI-NATIVE-SDLC.md`](./AI-NATIVE-SDLC.md) - where Specboards sits in
  Anthropic's AI-native SDLC playbook, including the stages we do not cover.
  The public version of this is the site's `/spec-driven-development` page, and
  the two must not contradict each other.

## Security posture

- [`security-review-2026-07.md`](./security-review-2026-07.md) - the July 2026
  adversarial source review. Kept because it records why several controls
  exist; a number of tests cite its findings as their rationale.
- [`security-audit-exceptions.md`](./security-audit-exceptions.md) - dependency
  advisories the CI audit gate is knowingly allowed to pass, and why.
- [`accessibility-conformance.md`](./accessibility-conformance.md) - our
  accessibility conformance statement and its known gaps.

## Operating our hosted instance

Internal procedures for `app.specboards.ai` and `test.specboards.ai`. Most
readers should skip this section: it assumes access to our Fly.io apps and
databases.

- [`RUNBOOK-db-role-cutover.md`](./RUNBOOK-db-role-cutover.md) - provisioning
  the non-owner `specboards_app` and `specboards_worker` database roles so
  row-level security is a live backstop rather than a dormant one.
- [`RUNBOOK-model-provider-credentials.md`](./RUNBOOK-model-provider-credentials.md) -
  storing, rotating, and bounding the egress of customer-supplied model keys.
- [`RUNBOOK-webhook-egress-policy.md`](./RUNBOOK-webhook-egress-policy.md) - the
  network-level control against webhook SSRF that sits outside the app.
- [`RUNBOOK-staging-pentest.md`](./RUNBOOK-staging-pentest.md) - running an
  authenticated penetration test against staging.
- [`RUNBOOK-github-install-bind-smoke-test.md`](./RUNBOOK-github-install-bind-smoke-test.md) -
  manual QA for the GitHub installation-bind takeover path.
- [`RUNBOOK-specboard-dogfood.md`](./RUNBOOK-specboard-dogfood.md) - how we run
  Specboards on its own repo, including the PR to work-item status loop.

## Early research

Design exploration from June 2026, before the current model settled. Kept
because the reasoning is still occasionally useful, but **these do not describe
the product as it is today** and should not be used as a reference for how it
behaves.

- [`research/spec-repo-strategy.md`](./research/spec-repo-strategy.md)
- [`research/onboarding-spec-hub-flow.md`](./research/onboarding-spec-hub-flow.md)

## What is deliberately not here

There is no backlog file and no archive directory in this repo.

The backlog lives in Specboards itself, at `app.specboards.ai`, because we
dogfood the product; a Markdown copy would be a second backlog that nobody
updates. Agents can read it over MCP with `list_items` and `read_item`.

Shipped plan and design documents are not archived either. Git history is the
archive, and a directory of stale plans makes it impossible to tell current
documentation from history without opening every file. What shipped when is in
[`CHANGELOG.md`](../CHANGELOG.md).
