/**
 * The row shapes local file mode persists, shared by more than one domain.
 *
 * A shape only one domain reads (a release row, a cycle row) lives with that
 * domain. What is here is what the store itself and several domains all have
 * to agree on: the DB-native item, the metadata laid over a spec-backed one,
 * and the relation edges between them.
 *
 * The three link helpers are here too, because a stored edge only means
 * anything alongside the shape it is stored in: which id it gets, which way
 * it points from one side, and how a viewer-relative direction becomes one.
 *
 * These are the on-disk contract. Changing a field name here changes what an
 * existing `.specboards/` directory means, so treat it as a migration rather
 * than a rename.
 */

import type {
  CustomFieldValue,
  RelationDirection,
  RelationInput,
} from "../types";

/** The single acting user in local (auth-disabled) file mode. */
export const LOCAL_USER = "local";

/** A DB-native work item (initiative/epic) persisted in local file mode. */
export interface LocalItem {
  /** Stable id, used as the public specId. */
  id: string;
  title: string;
  level: string;
  status: string;
  assigneeId: string | null;
  tags: string[];
  parentSpecId: string | null;
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  /** Owning cycle id, or null when not in one. Orthogonal to releaseId. */
  cycleId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
  /** Markdown details body, or null/absent for a blank body. */
  details?: string | null;
  /** Custom-property values keyed by property key. */
  customFields?: Record<string, CustomFieldValue>;
  /** RICE prioritization inputs (see RiceInputs). */
  riceReach?: number | null;
  riceImpact?: number | null;
  riceConfidence?: number | null;
  riceEffort?: number | null;
}

type LocalLinkType = "blocks" | "relates_to" | "duplicates";

/** A relation stored canonically on the `from` spec's metadata. */
interface LocalLink {
  to: string;
  type: LocalLinkType;
}

export interface LocalMetadata {
  status?: string;
  rank?: string | null;
  tags?: string[];
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  /** Owning cycle id, or null when not in one. Orthogonal to releaseId. */
  cycleId?: string | null;
  assigneeId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  /** RICE prioritization inputs (see RiceInputs). */
  riceReach?: number | null;
  riceImpact?: number | null;
  riceConfidence?: number | null;
  riceEffort?: number | null;
  /** Outgoing relations from this spec (see ./types FeatureRelation). */
  links?: LocalLink[];
  /** Parent feature (epic) spec id, or null when top-level. */
  parentSpecId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
}

export type MetadataFile = Record<string, LocalMetadata>;

/** A synthetic, stable id for a local relation (no DB rows to key on). */
export function localLinkId(fromSpec: string, link: LocalLink): string {
  return `${fromSpec}:${link.to}:${link.type}`;
}

/** Resolve a stored edge into the direction seen from `viewerSpec`. */
export function localDirection(
  fromSpec: string,
  type: LocalLinkType,
  viewerSpec: string,
): RelationDirection {
  const outgoing = fromSpec === viewerSpec;
  switch (type) {
    case "blocks":
      return outgoing ? "blocks" : "blocked_by";
    case "duplicates":
      return outgoing ? "duplicates" : "duplicated_by";
    case "relates_to":
      return "relates_to";
  }
}

/** Map a viewer-relative direction to a canonical stored edge (by specId). */
export function toLocalEdge(
  selfSpec: string,
  otherSpec: string,
  direction: RelationInput["direction"],
): { from: string; link: LocalLink } {
  switch (direction) {
    case "blocks":
      return { from: selfSpec, link: { to: otherSpec, type: "blocks" } };
    case "blocked_by":
      return { from: otherSpec, link: { to: selfSpec, type: "blocks" } };
    case "relates_to":
      return { from: selfSpec, link: { to: otherSpec, type: "relates_to" } };
    case "duplicates":
      return { from: selfSpec, link: { to: otherSpec, type: "duplicates" } };
  }
}
