import { type FeaturePatch, getStore, type WorkspaceScope } from "@/lib/store";
import { RelationError } from "@/lib/store/types";
import { parseFeaturePatch, patchFeature } from "@/lib/features-service";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";

/**
 * Patching many items in one request.
 *
 * Deliberately built on `patchFeature` rather than beside it: a bulk edit that
 * validated transitions or gates by its own rules would be a second write path
 * with a second set of answers, and the whole point of the endpoint is that it
 * does what the reader would have done one item at a time. What is genuinely
 * different here, and so is what this module owns, is the request shape, the
 * item cap, and reporting per-item outcomes instead of failing the batch.
 */

/** The fields a bulk edit may set directly. Tags are handled separately (add /
 * clear) so a mixed selection isn't clobbered by a single replacement; other
 * per-item concerns (title, rank, parent, details, customFields) are excluded. */
const BULK_PATCH_KEYS = ["status", "assigneeId", "releaseId", "cycleId"] as const;

/** Cap a single batch so one request can't fan out unbounded work. */
const BULK_MAX_ITEMS = 200;

/** Tag mutations applied per item as a merge (not a wholesale replace). */
interface BulkTagOps {
  /** Tags to add to each item, deduped against its existing tags. */
  addTags?: string[];
  /** Remove every tag from each selected item. */
  clearTags?: boolean;
}

interface BulkPatchRequest {
  specIds: string[];
  patch: FeaturePatch;
  tagOps: BulkTagOps;
}

/** Outcome for one item in a bulk edit. */
interface BulkPatchItemResult {
  specId: string;
  ok: boolean;
  /** Failure reason when `ok` is false (e.g. an illegal status transition). */
  error?: string;
}

interface BulkPatchResult {
  results: BulkPatchItemResult[];
  okCount: number;
  failCount: number;
}

/** Parse an untrusted bulk-PATCH body: `{ specIds, patch?, addTags?, clearTags? }`.
 * The direct patch is validated like a single edit then restricted to the
 * bulk-safe fields; tag ops are validated separately. At least one change must
 * be requested. */
export function parseBulkPatchRequest(body: unknown): BulkPatchRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.specIds) || raw.specIds.length === 0) {
    throw new InvalidPatchError("specIds must be a non-empty array.");
  }
  if (raw.specIds.some((s) => typeof s !== "string" || s === "")) {
    throw new InvalidPatchError("specIds must be non-empty strings.");
  }
  const specIds = [...new Set(raw.specIds as string[])];
  if (specIds.length > BULK_MAX_ITEMS) {
    throw new InvalidPatchError(
      `A bulk edit can target at most ${BULK_MAX_ITEMS} items.`,
    );
  }

  // The direct patch is optional (a request may be tag-only).
  let patch: FeaturePatch = {};
  const rawPatch = raw.patch;
  if (rawPatch !== undefined && !(typeof rawPatch === "object" && rawPatch !== null && Object.keys(rawPatch).length === 0)) {
    patch = parseFeaturePatch(rawPatch);
    const disallowed = Object.keys(patch).filter(
      (k) => !(BULK_PATCH_KEYS as readonly string[]).includes(k),
    );
    if (disallowed.length > 0) {
      throw new InvalidPatchError(
        `Bulk edits can only set ${BULK_PATCH_KEYS.join(", ")} (or add/clear tags); not ${disallowed.join(", ")}.`,
      );
    }
  }

  const tagOps: BulkTagOps = {};
  if ("addTags" in raw && raw.addTags !== undefined) {
    if (!Array.isArray(raw.addTags) || raw.addTags.some((t) => typeof t !== "string")) {
      throw new InvalidPatchError("addTags must be an array of strings.");
    }
    const cleaned = [...new Set((raw.addTags as string[]).map((t) => t.trim()).filter(Boolean))];
    if (cleaned.length > 0) tagOps.addTags = cleaned;
  }
  if (raw.clearTags === true) tagOps.clearTags = true;

  if (Object.keys(patch).length === 0 && !tagOps.addTags && !tagOps.clearTags) {
    throw new InvalidPatchError(
      "A bulk edit must change at least one of: status, assigneeId, releaseId, cycleId, addTags, clearTags.",
    );
  }
  if (tagOps.clearTags && tagOps.addTags) {
    throw new InvalidPatchError("clearTags and addTags can't be combined.");
  }
  return { specIds, patch, tagOps };
}

/**
 * Apply the same change to many items, each in its own transaction (via
 * {@link patchFeature}) so a rejection on one - an illegal status transition, an
 * unmet stage gate, a cross-product release - doesn't roll back the others.
 * Tag ops merge per item (add is deduped against existing tags; clear empties
 * them). Reuses every single-item guard and outbox emission, and returns a
 * per-item result so the caller can report exactly what changed.
 */
export async function bulkPatchFeatures(
  specIds: string[],
  patch: FeaturePatch,
  tagOps: BulkTagOps,
  scope?: WorkspaceScope,
): Promise<BulkPatchResult> {
  const store = await getStore();
  const results: BulkPatchItemResult[] = [];
  for (const specId of specIds) {
    try {
      const itemPatch: FeaturePatch = { ...patch };
      if (tagOps.clearTags) {
        itemPatch.tags = [];
      } else if (tagOps.addTags) {
        const feature = await store.getFeature(specId, scope);
        if (!feature) throw new FeatureNotFoundError(specId);
        itemPatch.tags = [...new Set([...feature.tags, ...tagOps.addTags])];
      }
      await patchFeature(specId, itemPatch, scope);
      results.push({ specId, ok: true });
    } catch (err) {
      if (
        err instanceof InvalidPatchError ||
        err instanceof FeatureNotFoundError ||
        err instanceof RelationError
      ) {
        results.push({ specId, ok: false, error: err.message });
      } else {
        throw err; // unexpected: let it surface rather than swallow it per item
      }
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { results, okCount, failCount: results.length - okCount };
}
