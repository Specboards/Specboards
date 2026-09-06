import {
  CUSTOM_GATE_FIELD_PREFIX,
  fieldGateSatisfied,
  gateFieldLabel,
  type GateField,
  type GateSubject,
} from "@specboards/core";

import { CUSTOM_FIELD_PREFIX } from "@/lib/card-fields";
import type { FeatureRecord, StageGate } from "@/lib/store/types";

/**
 * The web app's side of field-backed stage gates.
 *
 * The rules themselves (which fields can be required, what counts as populated,
 * how one is labelled) live in `@specboards/core` so the MCP server enforces
 * exactly the same thing over its own queries. What is left here is the
 * adapter from this app's shapes: a `FeatureRecord`, and a `StageGate` that may
 * be either kind.
 */

export { gateFieldCatalog, type GateField } from "@specboards/core";

// The two prefixes name the same thing from two directions: card fields grew
// theirs first, gates reuse it so an admin's custom property has one key
// everywhere. Asserted rather than assumed, so splitting them later fails here
// instead of silently in a gate that stops matching.
const _prefixesAgree: typeof CUSTOM_FIELD_PREFIX = CUSTOM_GATE_FIELD_PREFIX;
void _prefixesAgree;

/** A feature as a field gate reads it. */
function subject(feature: FeatureRecord): GateSubject {
  return {
    assigneeId: feature.assigneeId,
    releaseId: feature.releaseId,
    cycleId: feature.cycleId,
    // The store speaks in spec ids; core only asks whether there is a parent.
    parentId: feature.parentSpecId,
    tags: feature.tags,
    customFields: feature.customFields,
  };
}

/**
 * Whether one gate is satisfied for an item, whichever kind it is. The single
 * definition the item view and the transition check both use.
 */
export function gateSatisfied(
  gate: StageGate,
  feature: FeatureRecord,
  completedGateIds: ReadonlySet<string>,
  catalog: readonly GateField[],
): boolean {
  if (gate.kind === "field") {
    return gate.fieldKey
      ? fieldGateSatisfied(gate.fieldKey, subject(feature), catalog)
      : false;
  }
  return completedGateIds.has(gate.id);
}

/**
 * How a gate reads in a list. A field gate's stored label is a snapshot, so the
 * live catalog wins; a checklist gate's label is what an admin typed and is
 * authoritative.
 */
export function gateDisplayLabel(
  gate: StageGate,
  catalog: readonly GateField[],
): string {
  if (gate.kind === "field" && gate.fieldKey) {
    return gateFieldLabel(gate.fieldKey, catalog, gate.label);
  }
  return gate.label;
}
