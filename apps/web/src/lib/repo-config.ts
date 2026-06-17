import { promises as fs } from "node:fs";
import path from "node:path";

import {
  parseRepoConfigYaml,
  resolveWorkflow,
  type RepoConfig,
  type StatusWorkflow,
} from "@specboard/core";

import { getDb } from "@/lib/db";
import { getWorkspaceRepoConfig } from "@/lib/github-sync";
import { findRepoRoot } from "@/lib/store/local";

/**
 * Resolve the active {@link RepoConfig} for a content page or request. In DB
 * mode it comes from the workspace's connected repo (synced from
 * `.specboard/config.yml`); in local file mode it's read straight off disk.
 * `null` when there's no config — config-driven UI (custom fields) then simply
 * renders nothing. Accepts any tenant-scoped value (PageAccess or
 * WorkspaceScope); only `workspaceId` is used.
 */
export async function resolveRepoConfig(
  scope: { workspaceId: string } | null,
): Promise<RepoConfig | null> {
  if (scope) {
    const db = getDb();
    return db ? getWorkspaceRepoConfig(db, scope.workspaceId) : null;
  }
  try {
    const root = await findRepoRoot();
    const raw = await fs.readFile(path.join(root, ".specboard", "config.yml"), "utf8");
    return parseRepoConfigYaml(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the workspace's status workflow (custom statuses/transitions from
 * config, or the built-in default). Drives board columns, status selects, and
 * transition validation.
 */
export async function resolveWorkflowFor(
  scope: { workspaceId: string } | null,
): Promise<StatusWorkflow> {
  return resolveWorkflow(await resolveRepoConfig(scope));
}
