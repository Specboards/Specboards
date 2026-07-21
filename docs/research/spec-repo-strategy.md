# Specboards Repo & Spec Organization Strategy

**Status:** Research + recommendation (for discussion)
**Date:** 2026-06-15
**Audience:** Product / engineering leadership

---

## 1. Context: the customer question

Several customers working across multiple **service repos** have told us the same
thing: it's much easier to keep **all of their specs in a single repo** that carries a
**manifest/reference** to where the actual services live in other repos. Agents read
and reason over the specs in that one repo, while the **code work executes against
multiple repos/codebases** as needed.

That maps to three candidate models for Specboards:

- **Attach:** connect to an existing repo that already has specs inside it.
- **Create:** stand up a dedicated spec repo for a project/org.
- **Hybrid:** support both, and add the "one spec repo, many code repos" workflow.

This memo reviews how the leading spec-driven tooling (GitHub **Spec Kit**, **BMAD**)
and the broader agentic-development ecosystem recommend organizing repos and specs,
then recommends a direction for Specboards.

> ⚠️ **This is a nascent space.** Where a practice is genuinely settled we say so;
> where it is still emerging or contested we flag it. Treat "best practice" here as
> "current direction of travel," not gospel.

---

## 2. Where Specboards is today

Specboards currently uses a **per-repo, co-located spec** model:

- A `workspace` is the tenant root and can aggregate **many** `repositories` into one
  unified backlog/board. (`packages/db/src/schema.ts`, `ARCHITECTURE.md`)
- Each spec (`feature`) is **bound to a single `repo_id`** and joined to its git file
  via a stable `spec_id` UUID embedded in the spec's YAML frontmatter. The UUID
  decouples metadata from file path, so renames/moves never orphan a spec.
  (`packages/db/src/schema.ts`)
- Specs live **inside each connected repo** at `specs/<feature>/spec.md` (configurable
  via `specGlobs` in `.specboard/config.yml`). Content is cached in the `spec_index`
  table and synced on push. (`apps/web/src/lib/github-sync.ts`, `.specboard/config.yml`)
- Agents consume specs over MCP (`list_features`, `read_spec`, `update_status`), which
  read from the cached index rather than scanning git live. (`apps/mcp/src/server.ts`)

**The gap:** a workspace can span many repos, but **specs always live in the same repo
as the code they describe**. There is no model where one repo holds the specs while the
code work targets *other* repos. That is exactly what customers are asking for.

**Two existing primitives make us unusually well-positioned to close that gap:**

1. **Spec identity is a UUID**, already decoupled from path *and* repo.
2. **The workspace already spans multiple repos** and aggregates them into one view.

---

## 3. GitHub Spec Kit

**Default: specs co-located with code in a single repo.** `specify init` lays down
`.specify/` (with `memory/constitution.md`, templates, scripts) and a `specs/` tree of
numbered feature folders (`specs/001-feature/spec.md`, `plan.md`, `tasks.md`, …). The
workflow is **constitution → specify → plan → tasks → implement**, and specs are
explicitly meant to be "versioned, created in branches, and merged like code" as the
source of truth.

- Official toolkit & layout: <https://github.com/github/spec-kit>
- Method writeup: <https://github.com/github/spec-kit/blob/main/spec-driven.md>
- GitHub blog launch: <https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/>

**Multi-repo is an openly acknowledged, unsolved gap.** Spec Kit "makes the hard
assumption that users are going to initialize … in a single codebase," which the
maintainers admit "doesn't reflect reality" for microservice projects:

- Issue #891 (microservice architectures): <https://github.com/github/spec-kit/issues/891>
- Issue #2120 (coordinated branching across nested repos): <https://github.com/github/spec-kit/issues/2120>
- Discussion #1743 (separate specs repo + independent FE/BE; maintainer: "we're aware
  … and will be addressing this soon"): <https://github.com/github/spec-kit/discussions/1743>
- Discussion #769 (managing artifacts in a monorepo, no official guidance):
  <https://github.com/github/spec-kit/discussions/769>
- Discussion #1437 (should specs be committed at all): <https://github.com/github/spec-kit/discussions/1437>

The only current lever is `--no-git` (decouple spec management from branching). A
"central specs, published as versioned packages (OpenAPI/types)" pattern is discussed
but not first-class. **Net: the exact workflow our customers want is a known hole in
Spec Kit.**

---

## 4. BMAD-METHOD

**Default: docs/specs co-located in the code repo.** BMAD writes `docs/prd.md`,
`docs/architecture.md`, and sharded `docs/epics/` + `docs/stories/`, plus a
`_bmad/`/`.bmad-core/` framework dir. Its two-phase flow (planning → IDE
implementation) leans heavily on **document sharding** so a dev agent loads only the
self-contained story it needs. That is a context-economy technique worth noting regardless of
repo layout.

- Repo: <https://github.com/bmad-code-org/BMAD-METHOD>
- Docs: <https://deepwiki.com/bmad-code-org/BMAD-METHOD>

**But BMAD has a real multi-repo pattern**, unlike Spec Kit:

- **Orchestrator + component** model: a central repo holds the master PRD and
  cross-cutting architecture; component repos (backend/frontend/hardware) **sync
  bidirectionally** (read-only docs pushed down, component stories synced back to
  `/project-management/{component}/`), with feature-scoped output dirs to avoid merge
  conflicts. Discussion #1425: <https://github.com/bmad-code-org/BMAD-METHOD/discussions/1425>
  · Discussion #1705: <https://github.com/bmad-code-org/BMAD-METHOD/discussions/1705>
- **Federated Knowledge System** (extension): git-based, multi-repo knowledge with
  priority-based conflict resolution, flattening relevant repos into unified agent
  context: <https://github.com/vishalmysore/bmad-federated-knowledge>

**Net: BMAD validates the "central spec hub coordinating multiple code repos" idea**,
and shows the operational shape (sync + conflict avoidance) it tends to take.

---

## 5. Broader ecosystem patterns

The cross-repo context problem is being solved in several converging ways:

1. **Meta-repo / manifest with pinned refs**: a dedicated repo that holds *only*
   manifests + integration tests, pinning each component to an immutable tag/SHA
   (avoid floating `@main`). This is essentially the model our customers describe.
   GitHub Well-Architected polyrepo guidance:
   <https://wellarchitected.github.com/library/architecture/recommendations/implementing-polyrepo-engineering/>
2. **IDP catalogs as agent context**: Backstage-style `catalog-info.yaml` as the
   queryable system-of-record for services/dependencies, now extending toward an
   `AIContext` catalog kind for agent rules/skills. RFC #33575:
   <https://github.com/backstage/backstage/issues/33575> · context-engineering writeup:
   <https://roadie.io/blog/idp-ai-goldmine-context-engineering/>
3. **`CLAUDE.md` / `AGENTS.md` + `@import` composition**: agents walk the directory
   tree and compose layered instructions, enabling a shared spec/context source without
   duplication: <https://blink.new/blog/agents-md-vs-claude-md>
4. **Git submodules / "synthetic monorepo"**: nest dependent repos to give the agent a
   single unified filesystem view: <https://monorepo.tools/synthetic-monorepos>
5. **"Living specs" to fight spec drift**: the documented failure mode of *any* central
   spec store: the doc says X, the code says Y, and AI generation widens the gap.
   Mitigation is continuous drift detection/correction, not one-time prompts.
   <https://www.kinde.com/learn/ai-for-software-engineering/ai-devops/spec-drift-the-hidden-problem-ai-can-help-fix/>
   · <https://www.oreilly.com/radar/how-to-write-a-good-spec-for-ai-agents/>

---

## 6. The core tradeoff

| Dimension | Central spec repo (+ manifest) | Co-located specs (in each code repo) |
|---|---|---|
| Cross-cutting / multi-service changes | **Easier** (one place to plan) | Harder (coordinate across N repos) |
| Unified agent context | **Strong** (one place to read) | Fragmented across repos |
| Spec ↔ code drift | **Higher risk** (they can diverge) | **Lower** (atomic spec+code commits) |
| Discovery for agents | Out-of-band (needs manifest/catalog) | Natural (specs sit next to code) |
| Onboarding a single existing repo | Extra setup (hub + manifest) | **Trivial** (just attach) |
| Tooling maturity (industry) | Emerging, no standard yet | Default in Spec Kit & BMAD |

**Reading of the field:** co-location is the *current default*, but the *unsolved,
most-requested* problem (across Spec Kit issues, BMAD's orchestrator pattern, and
polyrepo/IDP guidance) is exactly the **central-spec-hub-coordinating-many-code-repos**
workflow our customers are describing. Its known Achilles' heel is **spec drift**.

---

## 7. Recommendation

**Support both, but lead with a hybrid "Spec Hub + manifest" model.** Do not force a
migration. Keep co-located specs as the zero-config on-ramp.

- **Keep "attach":** connecting an existing repo with in-repo `specs/` stays the
  simplest path and the default for single-repo teams.
- **Add "Spec Hub":** let a repo be designated a *spec hub* that holds `specs/` plus a
  **service manifest** (e.g. `.specboard/manifest.yml`) listing target service repos
  with **pinned references**. This directly serves the customer workflow and matches the
  industry meta-repo/manifest pattern.
- **Decouple "where the spec lives" from "where code executes":** a feature in the hub
  can reference one or more **target service repos**, so agents read the spec from the
  hub while code work is directed at the referenced repo(s).
- **Treat spec drift as the headline risk:** because the central model's documented
  weakness is divergence, pair it from day one with sync/validation and "living spec"
  checks (e.g. flag specs whose referenced services have moved past their pinned ref).

### Why this is the right bet for Specboards

- It **closes a gap Spec Kit and BMAD have publicly acknowledged but not shipped**. That's a
  genuine differentiator rather than catch-up.
- It **builds on primitives we already have**: spec identity is a UUID decoupled from
  path/repo (`packages/db/src/schema.ts`), and a workspace already spans multiple repos.
  The hub model is an extension of, not a rewrite of, today's architecture.
- It preserves the **simple attach experience** for the majority who don't need it.

---

## 8. Why Specboards is well-positioned (reusable primitives)

- **UUID spec identity** (`spec_id` in frontmatter) already separates a spec's identity
  from its location, which is the hard part of letting specs live in a different repo than code.
- **Multi-repo workspace** already aggregates repos; the manifest becomes structured
  data the workspace owns, and the MCP layer (`apps/mcp/src/server.ts`) is the natural
  place to expose "this spec → these target repos" to agents.
- **`spec_index` sync** (`apps/web/src/lib/github-sync.ts`) is an existing hook where
  manifest parsing and drift checks could live.

---

## 9. Risks & open questions

- **Spec drift / staleness:** the central model's main weakness. What's our detection
  and reconciliation story (pinned-ref checks, "living spec" validation, push webhooks
  on referenced repos)?
- **Manifest schema:** what does `.specboard/manifest.yml` contain (service name →
  repo, pinned ref, ownership, links)? Reuse/extend `.specboard/config.yml` or separate?
- **Agent execution model:** how does an agent reading a hub spec get pointed at, and
  authorized for, the correct *other* repo for code work? (GitHub App install scope.)
- **Data model:** is a "target repo" a new relation on `feature`, or a richer
  service/manifest entity? (Affects `features` / `repositories` in `schema.ts`.)
- **Migration / coexistence:** how do hub specs and co-located specs show up together
  in one backlog without confusion?
- **Standards drift:** Backstage `AIContext` and `AGENTS.md`/`@import` are moving fast;
  worth aligning our manifest with whatever consolidates.

---

## 10. References

**Spec Kit**
- <https://github.com/github/spec-kit>
- <https://github.com/github/spec-kit/blob/main/spec-driven.md>
- <https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/>
- Issues/discussions: #891, #2120 (issues); #1743, #769, #1437 (discussions)

**BMAD-METHOD**
- <https://github.com/bmad-code-org/BMAD-METHOD>
- <https://deepwiki.com/bmad-code-org/BMAD-METHOD>
- Discussions #1425, #1705
- <https://github.com/vishalmysore/bmad-federated-knowledge>

**Multi-repo / context engineering / drift**
- <https://wellarchitected.github.com/library/architecture/recommendations/implementing-polyrepo-engineering/>
- <https://roadie.io/blog/idp-ai-goldmine-context-engineering/>
- <https://github.com/backstage/backstage/issues/33575>
- <https://blink.new/blog/agents-md-vs-claude-md>
- <https://monorepo.tools/synthetic-monorepos>
- <https://www.kinde.com/learn/ai-for-software-engineering/ai-devops/spec-drift-the-hidden-problem-ai-can-help-fix/>
- <https://www.oreilly.com/radar/how-to-write-a-good-spec-for-ai-agents/>

**Specboards internal references**
- `packages/db/src/schema.ts` · `apps/mcp/src/server.ts` ·
  `apps/web/src/lib/github-sync.ts` · `.specboard/config.yml` · `ARCHITECTURE.md`
