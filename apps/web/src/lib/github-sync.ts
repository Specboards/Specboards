import {
  parseRepoConfigYaml,
  safeParseRepoConfig,
  type RepoConfig,
} from "@specboard/core";
import {
  and,
  eq,
  features,
  repositories,
  specIndex,
  type Database,
} from "@specboard/db";
import {
  createGitHubRepoClient,
  reconcileSpecs,
  type GitRepoClient,
} from "@specboard/git";

import { getGithubApp } from "@/lib/github-app";

export type RepoRecord = typeof repositories.$inferSelect;

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

/** Find a connected repository by owner + name (case-sensitive, as GitHub stores them). */
export async function resolveRepository(
  db: Database,
  owner: string,
  name: string,
): Promise<RepoRecord | null> {
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Import/reconcile a repository's specs into the DB. Lists every spec via the
 * GitHub App, injects stable ids where missing (committed back to git by
 * `reconcileSpecs`), then upserts `features` + `spec_index`. Files whose
 * `blobSha` already matches the stored index are skipped — that's how a push
 * touching one spec doesn't rewrite the rest.
 *
 * All writes use the owner connection (`db` from `getDb()`): this is owner-side
 * data ingestion, not a tenant request, so it does not go through RLS.
 */
export async function syncRepository(db: Database, repo: RepoRecord): Promise<SyncSummary> {
  const app = await getGithubApp(db);
  if (!app) {
    throw new Error("GitHub App is not configured. Set it up on the Repositories page.");
  }

  const client = await createGitHubRepoClient(app, {
    installationId: repo.githubInstallationId,
    owner: repo.owner,
    name: repo.name,
    ref: repo.defaultBranch,
  });

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

  // Existing blobShas keyed by specId, to skip unchanged files.
  const existingRows = await db
    .select({ specId: features.specId, blobSha: specIndex.blobSha })
    .from(features)
    .leftJoin(specIndex, eq(specIndex.featureId, features.id))
    .where(eq(features.repoId, repo.id));
  const existingBlob = new Map(existingRows.map((r) => [r.specId, r.blobSha]));

  const summary: SyncSummary = { upserted: 0, skipped: 0, idsInjected: 0 };

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
          specId,
          title: item.spec.frontmatter.title,
        })
        .onConflictDoUpdate({
          target: [features.repoId, features.specId],
          set: { title: item.spec.frontmatter.title, updatedAt: new Date() },
        })
        .returning({ id: features.id });
      if (!row) throw new Error(`Upsert returned no feature row for spec ${specId}`);

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
