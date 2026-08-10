import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_STATUSES,
  configPinsTransitions,
  defaultWorkflow,
  parseRepoConfigYaml,
  resolveWorkflow,
  workflowFromStages,
  type RepoConfig,
  type StatusWorkflow,
} from "@specboards/core";

import { getDb } from "@/lib/db";
import { getWorkspaceRepoConfig } from "@/lib/github-sync";
import { getStore } from "@/lib/store";
import { findRepoRoot } from "@/lib/store/local";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * Resolve the active {@link RepoConfig} for a content page or request. In DB
 * mode it comes from the workspace's connected repo (synced from
 * `.specboards/config.yml`); in local file mode it's read straight off disk.
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
    const raw = await fs.readFile(path.join(root, ".specboards", "config.yml"), "utf8");
    return parseRepoConfigYaml(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the status workflow for a product: the stage vocabulary and the moves
 * allowed between those stages. Drives board columns, status selects, and
 * transition validation.
 *
 * The vocabulary comes from admin-defined stages in the DB (Settings -> Cards
 * -> Workflow) first, then the repo config's statuses, then the built-in
 * default. The *transitions* come from the transition mode (strict = a
 * pipeline, flexible = any stage to any other), resolved in four layers:
 *
 *   1. a repo config that pins `transitions` in `.specboards/config.yml`
 *   2. the product's own setting
 *   3. the workspace default
 *   4. the built-in default
 *
 * Config still wins because it is a deliberate, version-controlled state
 * machine: a team that wrote one out means it, and it is the layer a product
 * admin cannot silently override. Everything below it is configuration, and
 * configuration gets more specific as it gets closer to the work.
 *
 * `productId` names the product being viewed; omit it (or pass null) for a
 * cross-product view, which resolves against the workspace default. Layers 2-4
 * are resolved by the store in one query.
 */
export async function resolveWorkflowFor(
  scope: WorkspaceScope | null,
  productId?: string | null,
): Promise<StatusWorkflow> {
  const store = await getStore();
  const [stages, config] = await Promise.all([
    store.listStatuses(scope ?? undefined),
    resolveRepoConfig(scope),
  ]);

  // A config-pinned state machine is authoritative, vocabulary and edges both.
  if (configPinsTransitions(config)) return resolveWorkflow(config);

  const mode = await store.getTransitionMode(scope ?? undefined, productId);
  const fromStages = workflowFromStages(stages, mode);
  if (fromStages) return fromStages;

  // No DB stages: take the vocabulary from the config (or the built-in one) and
  // apply the mode to it, so the setting governs a config-vocabulary workspace
  // the same way it governs a Settings-defined one.
  const vocabulary =
    config?.statuses && config.statuses.length >= 2
      ? config.statuses.filter((s) => s !== "archived")
      : DEFAULT_STATUSES.filter((s) => s !== "archived");
  return (
    workflowFromStages(
      vocabulary.map((key) => ({ key, label: statusLabelFromKey(key) })),
      mode,
    ) ?? defaultWorkflow
  );
}

/** Title-case a status key for a label (Setting-defined stages carry theirs). */
function statusLabelFromKey(key: string): string {
  return key
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
