import { isUuid } from "@/lib/uuid";
import { getStore, type WorkspaceScope } from "@/lib/store";
import {
  type CreatableRelationDirection,
  type FeatureRelation,
  RELATION_DIRECTIONS,
  type RelationInput,
} from "@/lib/store/types";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";

/** Typed relations between two items: blocks, relates to, duplicates. */

/** Parse and validate an untrusted relation-create body. */
export function parseRelationInput(body: unknown): RelationInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (!isUuid(raw.toSpecId)) {
    throw new InvalidPatchError("toSpecId must be a UUID.");
  }
  if (
    typeof raw.direction !== "string" ||
    !(RELATION_DIRECTIONS as readonly string[]).includes(raw.direction)
  ) {
    throw new InvalidPatchError(
      `direction must be one of: ${RELATION_DIRECTIONS.join(", ")}.`,
    );
  }
  return {
    toSpecId: raw.toSpecId,
    direction: raw.direction as CreatableRelationDirection,
  };
}

/** Create a relation from `specId`, returning its refreshed relation list. */
export async function addFeatureRelation(
  specId: string,
  input: RelationInput,
  scope?: WorkspaceScope,
): Promise<FeatureRelation[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.addRelation(specId, input, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.relations ?? [];
}

/** Remove a relation by id, returning the refreshed relation list. */
export async function removeFeatureRelation(
  specId: string,
  linkId: string,
  scope?: WorkspaceScope,
): Promise<FeatureRelation[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.removeRelation(specId, linkId, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.relations ?? [];
}
