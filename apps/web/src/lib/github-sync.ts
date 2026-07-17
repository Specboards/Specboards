import { randomUUID } from "node:crypto";

import {
  leafLevel,
  parentLevelKey,
  parseRepoConfigYaml,
  previewSpec,
  safeParseRepoConfig,
  type RepoConfig,
} from "@specboard/core";
import {
  and,
  eq,
  features,
  productRepositories,
  repositories,
  specIndex,
  workspaceLevels,
  type Database,
} from "@specboard/db";
import {
  createGitHubRepoClient,
  reconcileSpecs,
  type GitRepoClient,
} from "@specboard/git";

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
 * installation-scoped GitHub client via the App. Under `SPECBOARD_E2E` it
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
const CONFIG_PATH = ".specboard/config.yml";

/** Default when a repo has no `.specboard/config.yml` glob override yet. */
const DEFAULT_SPEC_GLOBS = ["specs/**/spec.md"];

/** Outcome of syncing one repository. */
export interface SyncSummary {
  /** Specs whose content changed (or are new) and were written to the DB. */
  upserted: number;
  /** Specs already in sync (matching `blobSha`) that were left untouched. */
  skipped: number;
  /** Specs that had a stable id injected back into git during this sync. */
  idsInjected: number;
  /** Feature groupings auto-created to home newly-synced work items. */
  featuresCreated: number;
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

/** Human label for an auto-created Feature, derived from its grouping key. */
function featureTitleFor(key: string, fallbackTitle: string): string {
  const raw = key.startsWith("feature:")
    ? key.slice("feature:".length)
    : key.startsWith("path:")
      ? key.slice(key.lastIndexOf("/") + 1)
      : "";
  const cleaned = raw.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return fallbackTitle;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
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
 * Read and validate `.specboard/config.yml` from the repo, or `null` if it's
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

/** Slugify a feature name into a path segment (lowercase, hyphen-separated). */
export function featureSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

This is your first Specboard spec. It lives in your repository as
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
 * passes the dedicated `specboard_worker` connection (`getWorkerDb()`), a narrow
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
    featuresCreated: 0,
  };

  await db.transaction(async (tx) => {
    for (const item of reconciled) {
      if (item.idInjected) summary.idsInjected += 1;

      const specId = item.spec.frontmatter.id;
      if (existingBlob.get(specId) === item.blobSha) {
        summary.skipped += 1;
        continue;
      }

      // features holds user-managed metadata (status/priority/…) — only the
      // git-derived title is reconciled here; the rest is preserved on update.
      const [row] = await tx
        .insert(features)
        .values({
          workspaceId: repo.workspaceId,
          repoId: repo.id,
          productId,
          specId,
          level: leafKey,
          title: item.spec.frontmatter.title,
        })
        // productId is set only on insert; an item moved to another product
        // later keeps its assignment across re-syncs. level is reconciled so a
        // spec row always converges to the current leaf.
        .onConflictDoUpdate({
          target: [features.repoId, features.specId],
          set: {
            title: item.spec.frontmatter.title,
            level: leafKey,
            updatedAt: new Date(),
          },
        })
        .returning({ id: features.id, parentId: features.parentId });
      if (!row) throw new Error(`Upsert returned no feature row for spec ${specId}`);

      // Home the work item under a Feature grouping. Only when it has no parent
      // yet — so a re-sync never overrides a parent a user set in the app. The
      // Feature is found (or created) by a stable grouping key so re-syncs and
      // sibling specs reuse it rather than spawning duplicates.
      if (featureLevelKey && row.parentId === null) {
        const key = featureKeyFor(item.spec.frontmatter.feature, item.path, specId);
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
        let featureId = existing[0]?.id;
        if (!featureId) {
          const newId = randomUUID();
          await tx.insert(features).values({
            id: newId,
            workspaceId: repo.workspaceId,
            repoId: null,
            productId,
            specId: newId,
            level: featureLevelKey,
            externalKey: key,
            title: featureTitleFor(key, item.spec.frontmatter.title),
          });
          featureId = newId;
          summary.featuresCreated += 1;
        }
        await tx
          .update(features)
          .set({ parentId: featureId })
          .where(eq(features.id, row.id));
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
