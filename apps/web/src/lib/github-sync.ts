import { randomUUID } from "node:crypto";

import {
  featureSlug,
  leafLevel,
  parentLevelKey,
  parseRepoConfigYaml,
  previewSpec,
  resolveWriteMode,
  safeParseRepoConfig,
  type RepoConfig,
  type ResolvedWriteMode,
} from "@specboards/core";
import {
  and,
  eq,
  features,
  isNull,
  or,
  productRepositories,
  repositories,
  specIndex,
  workspaceLevels,
  type Database,
} from "@specboards/db";
import {
  createGitHubRepoClient,
  reconcileSpecs,
  type GitRepoClient,
} from "@specboards/git";

import { isE2E } from "@/lib/e2e";
import { getGithubApp } from "@/lib/github-app";
import { fakeRepoClient } from "@/lib/github-e2e";
import { ensureDefaultProduct } from "@/lib/workspace";

export type RepoRecord = typeof repositories.$inferSelect;

/**
 * The product this repo's newly discovered specs are assigned to: the linked
 * product marked `isDefault` in `product_repositories`, else the workspace's
 * default product. The fallback covers repos connected before links existed
 * (the 0040 backfill pins those explicitly), repos whose links were removed,
 * and self-heals if a default row disappears (its product was deleted).
 */
export async function resolveRepoDefaultProduct(
  db: Database,
  repo: Pick<RepoRecord, "id" | "workspaceId">,
): Promise<string> {
  const row = await db
    .select({ productId: productRepositories.productId })
    .from(productRepositories)
    .where(
      and(
        eq(productRepositories.repoId, repo.id),
        eq(productRepositories.isDefault, true),
      ),
    )
    .limit(1);
  return row[0]?.productId ?? ensureDefaultProduct(db, repo.workspaceId);
}

/**
 * Resolve the git client for a connected repo. Normally this mints an
 * installation-scoped GitHub client via the App. Under `SPECBOARDS_E2E` it
 * returns the in-memory fake (see github-e2e.ts) so tests run with no network.
 * The single choke point for every GitHub read/write in this module (and for
 * the GitHub-backed doc spaces in github-docs.ts).
 */
export async function resolveRepoClient(
  db: Database,
  repo: RepoRecord,
): Promise<GitRepoClient> {
  if (isE2E()) return fakeRepoClient(repo);
  const app = await getGithubApp(db);
  if (!app) {
    throw new Error("GitHub App is not configured. Set it up on the Repositories page.");
  }
  return createGitHubRepoClient(app, {
    installationId: repo.githubInstallationId,
    owner: repo.owner,
    name: repo.name,
    ref: repo.defaultBranch,
  });
}

/** Path of the per-repo config file, relative to the repo root. */
const CONFIG_PATH = ".specboards/config.yml";

/** Default when a repo has no `.specboards/config.yml` glob override yet. */
const DEFAULT_SPEC_GLOBS = ["specs/**/spec.md"];

/** Outcome of syncing one repository. */
export interface SyncSummary {
  /** Specs whose content changed (or are new) and were written to the DB. */
  upserted: number;
  /** Specs already in sync (matching `blobSha`) that were left untouched. */
  skipped: number;
  /** Specs that had a stable id injected back into git during this sync. */
  idsInjected: number;
  /** Specs attached to a work item that already existed (created in the app, or
   * previously synced), rather than creating a new one. */
  attached: number;
  /** Imports that matched no existing Feature grouping and so landed
   * unparented. Sync no longer invents a grouping for them (ADR 0003 D3);
   * they surface in the Unassigned view to be placed by hand. */
  unparented: number;
}

/**
 * The grouping key for a spec's Feature: its `feature` frontmatter when set,
 * else its folder path (so specs in the same directory share a Feature). Falls
 * back to a per-spec key for a spec at the repo root (keeps it 1:1).
 */
function featureKeyFor(frontmatterFeature: string | undefined, path: string, specId: string): string {
  const declared = frontmatterFeature?.trim();
  if (declared) return `feature:${declared}`;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return dir ? `path:${dir}` : `spec:${specId}`;
}

/** How sync assigned an item's parent: on import, or by a person in the app. */
export type ParentSetBy = "system" | "user" | null;

/** What a re-sync should do with one spec's Feature parent (see decideReparent). */
export type ReparentAction =
  /** Assign a system parent under the current grouping key (first import). */
  | { kind: "home" }
  /** Move the system parent to the grouping the frontmatter now points at. */
  | { kind: "rehome" }
  /** Record the current key as the baseline, without moving the parent. */
  | { kind: "baseline" }
  /** The `feature:` frontmatter changed but the parent is user-owned: skip it. */
  | { kind: "override" }
  /** Nothing to do. */
  | { kind: "noop" };

/**
 * Decide how a re-sync should treat a spec's Feature parent, given the row's
 * current parent state and the grouping key its frontmatter now resolves to.
 * Pure so it can be unit-tested without a database; the caller performs the
 * chosen action (see the sync loop).
 *
 * - No parent and not user-detached -> `home` (first import, unchanged).
 * - System parent whose key changed -> `rehome` (the gh-51 fix).
 * - User-set parent whose key changed -> `override` (honor the manual parent).
 * - System parent with no recorded key yet -> `baseline` (a backfilled row;
 *   record the key so the *next* frontmatter change is detectable).
 * - Otherwise -> `noop` (key unchanged, or a user row we must not touch).
 */
export function decideReparent(
  row: {
    parentId: string | null;
    parentSetBy: ParentSetBy;
    syncedFeatureKey: string | null;
  },
  key: string,
): ReparentAction {
  const userOwned = row.parentSetBy === "user";
  if (row.parentId === null) {
    // A user who deliberately unparented an item (Unassigned view) keeps it
    // there; only a never-homed row gets a first parent.
    return userOwned ? { kind: "noop" } : { kind: "home" };
  }
  const keyChanged =
    row.syncedFeatureKey !== null && row.syncedFeatureKey !== key;
  if (keyChanged) return userOwned ? { kind: "override" } : { kind: "rehome" };
  // Parent exists and the key is unchanged (or untracked). Record a baseline
  // for a system row that predates key tracking so a future change is caught.
  if (!userOwned && row.syncedFeatureKey === null) return { kind: "baseline" };
  return { kind: "noop" };
}

/**
 * The write mode in effect for the repo the spec `specId` lives in, or null
 * when the item has no connected repo (a DB-native card, or a repo that was
 * disconnected). Read before the editor is shown, so the author is told what
 * saving will do *before* they do it rather than after.
 */
export async function resolveSpecWriteMode(
  db: Database,
  workspaceId: string,
  specId: string,
): Promise<ResolvedWriteMode | null> {
  const [row] = await db
    .select({ config: repositories.config })
    .from(features)
    .innerJoin(repositories, eq(repositories.id, features.repoId))
    .where(
      and(eq(features.specId, specId), eq(features.workspaceId, workspaceId)),
    )
    .limit(1);
  return row ? resolveWriteMode(row.config) : null;
}

/** The spec globs configured for a repo, falling back to the default. */
export function repoGlobs(repo: RepoRecord): string[] {
  const config = repo.config as { specGlobs?: unknown } | null;
  const globs = config?.specGlobs;
  if (Array.isArray(globs) && globs.length > 0 && globs.every((g) => typeof g === "string")) {
    return globs as string[];
  }
  return DEFAULT_SPEC_GLOBS;
}

/**
 * Read and validate `.specboards/config.yml` from the repo, or `null` if it's
 * absent/unreadable (a repo without one falls back to defaults).
 */
async function readRepoConfigFromGit(client: GitRepoClient): Promise<RepoConfig | null> {
  try {
    const file = await client.readFile(CONFIG_PATH);
    return parseRepoConfigYaml(file.raw);
  } catch {
    return null;
  }
}

/**
 * The RepoConfig for a workspace's connected repo (the first one carrying a
 * stored config), or `null`. Drives config-derived UI such as custom fields.
 */
export async function getWorkspaceRepoConfig(
  db: Database,
  workspaceId: string,
): Promise<RepoConfig | null> {
  const rows = await db
    .select({ config: repositories.config })
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId));
  for (const row of rows) {
    const config = safeParseRepoConfig(row.config);
    if (config) return config;
  }
  return null;
}

/** A spec file found in a repo during a read-only scan (no import performed). */
export interface SpecScanItem {
  /** Path to the spec file within the repo. */
  path: string;
  /** Best-effort display title (frontmatter title, first heading, or folder name). */
  title: string;
  /** Whether the spec already carries a stable id (false means import injects one). */
  hasId: boolean;
}

/** The scan result for one connected repository. */
export interface RepoScan {
  repoId: string;
  owner: string;
  name: string;
  specs: SpecScanItem[];
  /** Set when the repo could not be scanned (e.g. the App lost access). */
  error?: string;
}

/** A title for a spec when neither frontmatter nor a heading gives one: its folder name. */
function titleFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  // Prefer the containing folder (specs/<feature>/spec.md -> "<feature>"), else the file name.
  const raw = segments.length >= 2 ? segments[segments.length - 2]! : segments[segments.length - 1] ?? path;
  const cleaned = raw.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  if (!cleaned) return path;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Scan one connected repo for spec files WITHOUT importing them: list the files
 * matching the repo's globs and read a best-effort title from each. Read-only,
 * so it never injects ids or writes to git/DB. Powers the onboarding "found N
 * specs, import them?" prompt before any cards are created.
 */
export async function scanRepositorySpecs(db: Database, repo: RepoRecord): Promise<SpecScanItem[]> {
  const client = await resolveRepoClient(db, repo);
  // Read globs from git config when present, but do not persist anything here.
  const config = await readRepoConfigFromGit(client);
  const globs = config?.specGlobs ?? repoGlobs(repo);

  const files = await client.listSpecFiles(globs);
  return files.map((file) => {
    const preview = previewSpec(file.raw);
    return {
      path: file.path,
      title: preview.title ?? titleFromPath(file.path),
      hasId: preview.hasId,
    };
  });
}

/**
 * Scan every connected repo in a workspace for spec files (read-only). Per-repo
 * failures are captured as `error` so one inaccessible repo doesn't sink the
 * whole scan.
 */
export async function scanWorkspaceSpecs(db: Database, workspaceId: string): Promise<RepoScan[]> {
  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId));

  const scans: RepoScan[] = [];
  for (const repo of repos) {
    try {
      const specs = await scanRepositorySpecs(db, repo);
      scans.push({ repoId: repo.id, owner: repo.owner, name: repo.name, specs });
    } catch (err) {
      scans.push({
        repoId: repo.id,
        owner: repo.owner,
        name: repo.name,
        specs: [],
        error: err instanceof Error ? err.message : "Scan failed.",
      });
    }
  }
  return scans;
}

/** The starter spec.md body we commit on a user's first walkthrough. */
function starterSpecContent(title: string, id: string): string {
  // Double-quote the title (JSON is valid YAML) so names with colons etc. stay valid.
  return `---
id: ${id}
title: ${JSON.stringify(title)}
kind: feature
---

# ${title}

This is your first Specboards spec. It lives in your repository as
\`specs/${featureSlug(title)}/spec.md\` and stays in sync with this card on every
push. Edit it in git; the board follows.

## Problem

What problem are we solving, and for whom?

## Proposal

What are we building?

## Acceptance criteria

- [ ] First thing it must do
- [ ] Second thing it must do
`;
}

/** Outcome of seeding a starter spec into a repo. */
export interface StarterSpecResult {
  /** Path of the spec file committed to the repo. */
  path: string;
  /** The import summary from syncing the repo after the commit. */
  summary: SyncSummary;
}

/**
 * Commit a starter `specs/<feature>/spec.md` into a connected repo, then import
 * it so a card appears on the board. The "build your first spec" walkthrough for
 * a workspace whose repos have no specs yet, so a new admin can feel the whole
 * loop (commit -> sync -> card) end to end. Refuses to overwrite an existing
 * file at the target path.
 */
export async function createStarterSpec(
  db: Database,
  repo: RepoRecord,
  featureName: string,
): Promise<StarterSpecResult> {
  const title = featureName.trim();
  const slug = featureSlug(title);
  if (!slug) {
    throw new Error("Give the feature a name with at least one letter or number.");
  }

  const client = await resolveRepoClient(db, repo);

  const path = `specs/${slug}/spec.md`;
  // Don't clobber an existing spec at that path.
  let exists = false;
  try {
    await client.readFile(path);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`${path} already exists in ${repo.owner}/${repo.name}. Pick a different name.`);
  }

  await client.writeFile({
    path,
    content: starterSpecContent(title, randomUUID()),
    message: `docs(specboard): add starter spec ${path}`,
    mode: "direct",
  });

  // Import it so the card shows up immediately (completes the walkthrough loop).
  const summary = await syncRepository(db, repo);
  return { path, summary };
}

/**
 * Every connected repository matching owner + name (case-sensitive, as GitHub
 * stores them). Returns all rows, not one: the unique key is
 * (workspaceId, owner, name), so two workspaces can each connect the same repo.
 * A webhook carries no workspace context, so it must fan out to every tenant
 * that connected the repo rather than picking one nondeterministically.
 */
export async function resolveRepositories(
  db: Database,
  owner: string,
  name: string,
): Promise<RepoRecord[]> {
  return db
    .select()
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)));
}

/**
 * Import/reconcile a repository's specs into the DB. Lists every spec via the
 * GitHub App, injects stable ids where missing (committed back to git by
 * `reconcileSpecs`), then upserts `features` + `spec_index`. Files whose
 * `blobSha` already matches the stored index are skipped — that's how a push
 * touching one spec doesn't rewrite the rest.
 *
 * Writes use whichever connection the caller passes. The GitHub webhook sink
 * passes the dedicated `specboards_worker` connection (`getWorkerDb()`), a narrow
 * non-owner role scoped to just the ingestion tables with role-targeted RLS
 * policies for cross-workspace access; other callers may pass the owner
 * connection. Either way this is cross-workspace ingestion, not a per-user
 * tenant request.
 */
export async function syncRepository(db: Database, repo: RepoRecord): Promise<SyncSummary> {
  const client = await resolveRepoClient(db, repo);

  // Refresh the repo's config from git so glob/field changes take effect, and
  // resolve the globs to scan from it (falling back to the stored/default).
  const config = await readRepoConfigFromGit(client);
  if (config) {
    await db
      .update(repositories)
      .set({ config })
      .where(eq(repositories.id, repo.id));
  }
  const globs = config?.specGlobs ?? repoGlobs(repo);

  const reconciled = await reconcileSpecs(client, globs);

  // Synced specs land in the repo's default product (until moved later); a
  // repo without product links falls back to the workspace default.
  const productId = await resolveRepoDefaultProduct(db, repo);

  // Specs are the spec-backed leaf; set the level explicitly from the
  // workspace's configured hierarchy rather than relying on the column default
  // (which can drift from a workspace that renamed its leaf). See ADR 0002.
  const levelRows = await db
    .select({
      key: workspaceLevels.key,
      label: workspaceLevels.label,
      position: workspaceLevels.position,
      isLeaf: workspaceLevels.isLeaf,
    })
    .from(workspaceLevels)
    .where(eq(workspaceLevels.workspaceId, repo.workspaceId));
  const levels = levelRows.length > 0 ? levelRows : null;
  const leafKey = leafLevel(levels).key;
  // The level a Feature grouping sits at (one above the spec leaf). Null only
  // for a single-level hierarchy, where there's nowhere to home work items.
  const featureLevelKey = parentLevelKey(leafKey, levels);

  // Existing blobShas keyed by specId, to skip unchanged files.
  const existingRows = await db
    .select({ specId: features.specId, blobSha: specIndex.blobSha })
    .from(features)
    .leftJoin(specIndex, eq(specIndex.featureId, features.id))
    .where(eq(features.repoId, repo.id));
  const existingBlob = new Map(existingRows.map((r) => [r.specId, r.blobSha]));

  const summary: SyncSummary = {
    upserted: 0,
    skipped: 0,
    idsInjected: 0,
    attached: 0,
    unparented: 0,
  };

  await db.transaction(async (tx) => {
    for (const item of reconciled) {
      if (item.idInjected) summary.idsInjected += 1;

      const specId = item.spec.frontmatter.id;
      if (existingBlob.get(specId) === item.blobSha) {
        summary.skipped += 1;
        continue;
      }

      // A spec is an attachment, not an identity (ADR 0003 D3), so there are
      // exactly two cases: the frontmatter id already names a work item in this
      // workspace, in which case the spec attaches to that row; or it names
      // nothing, in which case sync creates the work item.
      //
      // The lookup is by (workspace, spec_id) rather than the old
      // (repo_id, spec_id) upsert target, because the item being attached to
      // may have been created in the app and so carry no repo at all. Rows
      // belonging to a *different* connected repo are excluded, so two repos
      // holding a copied spec file keep their own rows instead of one stealing
      // the other's.
      const [existingRow] = await tx
        .select({
          id: features.id,
          parentId: features.parentId,
          parentSetBy: features.parentSetBy,
          syncedFeatureKey: features.syncedFeatureKey,
        })
        .from(features)
        .where(
          and(
            eq(features.workspaceId, repo.workspaceId),
            eq(features.specId, specId),
            or(isNull(features.repoId), eq(features.repoId, repo.id)),
          ),
        )
        .limit(1);

      // features holds user-managed metadata (status/priority/…) — only the
      // git-derived title is reconciled here; the rest is preserved on update.
      // productId is set only on create; an item moved to another product later
      // keeps its assignment across re-syncs. level is reconciled so an
      // attached row always converges to the current leaf.
      let row: {
        id: string;
        parentId: string | null;
        parentSetBy: string | null;
        syncedFeatureKey: string | null;
      };
      if (existingRow) {
        await tx
          .update(features)
          .set({
            repoId: repo.id,
            title: item.spec.frontmatter.title,
            level: leafKey,
            updatedAt: new Date(),
          })
          .where(eq(features.id, existingRow.id));
        row = existingRow;
        summary.attached += 1;
      } else {
        const [inserted] = await tx
          .insert(features)
          .values({
            workspaceId: repo.workspaceId,
            repoId: repo.id,
            productId,
            specId,
            level: leafKey,
            title: item.spec.frontmatter.title,
          })
          .returning({
            id: features.id,
            parentId: features.parentId,
            parentSetBy: features.parentSetBy,
            syncedFeatureKey: features.syncedFeatureKey,
          });
        if (!inserted)
          throw new Error(`Insert returned no feature row for spec ${specId}`);
        row = inserted;
      }

      // Home the work item under a Feature grouping, keyed by a stable grouping
      // key so re-syncs and sibling specs reuse it. decideReparent honors a
      // parent a user set in the app: it re-homes only system-assigned parents
      // when the `feature:` frontmatter changed, and tracks the last-synced key
      // on the row (gh-51).
      //
      // Sync no longer *creates* the grouping when the key matches nothing
      // (ADR 0003 D3). That mechanism existed because a spec was once the only
      // way to bring a leaf item into existence, so every import needed a
      // parent invented for it; it is also where the wrapper-orphan bug came
      // from. An import that matches no existing grouping now lands unparented,
      // where the Unassigned view surfaces it for someone to place. Groupings a
      // workspace already has keep working exactly as before.
      if (featureLevelKey) {
        const key = featureKeyFor(item.spec.frontmatter.feature, item.path, specId);
        const action = decideReparent(
          {
            parentId: row.parentId,
            parentSetBy: row.parentSetBy as ParentSetBy,
            syncedFeatureKey: row.syncedFeatureKey,
          },
          key,
        );
        if (action.kind === "home" || action.kind === "rehome") {
          const existing = await tx
            .select({ id: features.id })
            .from(features)
            .where(
              and(
                eq(features.workspaceId, repo.workspaceId),
                eq(features.externalKey, key),
                eq(features.level, featureLevelKey),
              ),
            )
            .limit(1);
          const featureId = existing[0]?.id;
          if (featureId) {
            await tx
              .update(features)
              .set({ parentId: featureId, parentSetBy: "system", syncedFeatureKey: key })
              .where(eq(features.id, row.id));
          } else {
            // No grouping to home it under. Record the key anyway so that if
            // one is created with this key later, a re-sync sees an unchanged
            // key rather than treating it as a frontmatter change.
            await tx
              .update(features)
              .set({ syncedFeatureKey: key })
              .where(eq(features.id, row.id));
            summary.unparented += 1;
          }
        } else if (action.kind === "baseline") {
          // Record the current key without moving the parent, so a later
          // frontmatter change on this pre-tracking row is detectable.
          await tx
            .update(features)
            .set({ syncedFeatureKey: key })
            .where(eq(features.id, row.id));
        } else if (action.kind === "override") {
          // A frontmatter change is intentionally ignored because the parent
          // was set by hand. Log it so the divergence is visible in the sync
          // output (see RUNBOOK-github-sync).
          console.info(
            `[sync] spec ${specId}: feature: frontmatter changed to "${key}" ` +
              `but its parent was set in the app; leaving it in place.`,
          );
        }
      }

      const parsed = { title: item.spec.frontmatter.title, sections: item.spec.sections };
      await tx
        .insert(specIndex)
        .values({
          featureId: row.id,
          path: item.path,
          blobSha: item.blobSha,
          content: item.spec.content,
          parsed,
        })
        .onConflictDoUpdate({
          target: specIndex.featureId,
          set: {
            path: item.path,
            blobSha: item.blobSha,
            content: item.spec.content,
            parsed,
            lastSyncedAt: new Date(),
          },
        });

      summary.upserted += 1;
    }
  });

  return summary;
}
