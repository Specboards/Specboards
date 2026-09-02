import { getDb } from "@/lib/db";
import { deleteSpecFile } from "@/lib/spec-content";
import { notifyOutbox } from "@/lib/webhooks/events";
import {
  type FeatureRecord,
  type FeatureStore,
  getStore,
  type OutboxEmit,
  type WorkspaceScope,
} from "@/lib/store";
import type { CreateFeatureInput } from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * Creating and deleting a work item, which is the card itself rather than any
 * one of its fields.
 *
 * Apart from `features-service` because the lifecycle questions are different
 * ones: what a new card inherits from its level, and what has to be cleaned up
 * (a spec file, links, relations) before an existing one can go.
 */

/**
 * Create a DB-native work item (initiative/epic). Validation lives in the store.
 *
 * A caller that says nothing about `details` gets the body the workspace
 * configured for that level (its detail template). The "New item" drawer seeds
 * the same template into its editor and then sends whatever the user left
 * there, including an explicit null when they cleared it, so seeding here only
 * fills the gap for the paths that never ask: the per-column quick add, the API,
 * the MCP tools.
 */
export async function createWorkItem(
  input: CreateFeatureInput,
  scope?: WorkspaceScope,
): Promise<FeatureRecord> {
  const store = await getStore();
  const seeded =
    input.details === undefined
      ? {
          ...input,
          details: await levelTemplateBody(store, input.level, scope),
        }
      : input;
  // The store records item.created in the create transaction (it builds the data
  // from the new row, since specId is generated there).
  const created = await store.createFeature(seeded, scope, "item.created");
  notifyOutbox();
  return created;
}

/** The body of the detail template assigned to `levelKey`, or null if the level
 * has no template (or the assigned one has since been deleted). */
async function levelTemplateBody(
  store: FeatureStore,
  levelKey: string,
  scope?: WorkspaceScope,
): Promise<string | null> {
  const levels = await store.listLevels(scope);
  const templateId = levels.find((l) => l.key === levelKey)?.detailTemplateId;
  if (!templateId) return null;
  const templates = await store.listDetailTemplates(scope);
  return templates.find((t) => t.id === templateId)?.body?.trim() || null;
}

/**
 * Delete a work item by id. An item with a spec attached needs `removeSpec`,
 * which deletes the spec file from git first: leaving it behind would let the
 * next sync re-import the spec and recreate the item (ADR 0003 D4). Without
 * the opt-in the store refuses and says so.
 */
export async function deleteWorkItem(
  specId: string,
  scope?: WorkspaceScope,
  opts: { removeSpec?: boolean } = {},
): Promise<void> {
  const store = await getStore();
  // Read the item first so the event can describe what was removed; the store
  // records item.deleted in the same transaction as the delete.
  const existing = await store.getFeature(specId, scope);
  const emit: OutboxEmit | undefined = existing
    ? {
        type: "item.deleted",
        productId: existing.productId,
        data: {
          specId: existing.specId,
          title: existing.title,
          level: existing.level,
        },
      }
    : undefined;

  // Remove the git file before the row. The other order would leave a spec in
  // the repo with no item to re-import onto if the git call then failed; this
  // order fails with the file already gone, which the next sync reconciles.
  let specRemoved = false;
  const hasSpec = existing != null && !existing.isDbNative;
  if (hasSpec && opts.removeSpec) {
    const db = getDb();
    if (!db) {
      throw new InvalidPatchError(
        "Removing a spec file needs a connected repository, which local file " +
          "mode has none of. Delete the file directly instead.",
      );
    }
    await deleteSpecFile(db, scope!, specId);
    specRemoved = true;
  }

  await store.deleteFeature(specId, scope, emit, {
    // Local file mode owns its working tree and removes the file itself, so it
    // just needs the confirmation; the DB store needs it to have already gone.
    specRemoved: specRemoved || (hasSpec && opts.removeSpec === true),
  });
  if (emit) notifyOutbox();
}
