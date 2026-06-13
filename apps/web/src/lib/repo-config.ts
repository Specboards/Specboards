import { promises as fs } from "node:fs";
import path from "node:path";

import { parseRepoConfigYaml, type RepoConfig } from "@specboard/core";

import { getDb } from "@/lib/db";
import { getWorkspaceRepoConfig } from "@/lib/github-sync";
import { findRepoRoot } from "@/lib/store/local";
import type { PageAccess } from "@/lib/workspace-access";

/**
 * Resolve the active {@link RepoConfig} for a content page. In DB mode it comes
 * from the workspace's connected repo (synced from `.specboard/config.yml`); in
 * local file mode it's read straight off disk. `null` when there's no config —
 * config-driven UI (custom fields) then simply renders nothing.
 */
export async function resolveRepoConfig(access: PageAccess | null): Promise<RepoConfig | null> {
  if (access) {
    const db = getDb();
    return db ? getWorkspaceRepoConfig(db, access.workspaceId) : null;
  }
  try {
    const root = await findRepoRoot();
    const raw = await fs.readFile(path.join(root, ".specboard", "config.yml"), "utf8");
    return parseRepoConfigYaml(raw);
  } catch {
    return null;
  }
}
