import { propertyKeyFromLabel } from "@specboards/core";
import { getStore, type WorkspaceScope } from "@/lib/store";
import type {
  StageGate,
  StageGateInput,
  StatusStageInput,
  TransitionMode,
  WorkspaceStatus,
} from "@/lib/store/types";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";

/**
 * A product's workflow: its statuses, how they may be walked, and the gates
 * that must be satisfied to leave a stage.
 *
 * Configuration only. Enforcing a gate when an item moves is `features-service`,
 * which reads the same rows straight from the store, so this module knows
 * nothing about an item beyond the spec id a completion is recorded against.
 */

/** The workspace's workflow stages, or `[]` when using the built-in default. */
export async function listStatuses(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  const store = await getStore();
  return store.listStatuses(scope, productId);
}

/**
 * How freely items may move between stages, for one product. Omit `productId`
 * for the workspace default.
 */
export async function getTransitionMode(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<TransitionMode> {
  const store = await getStore();
  return store.getTransitionMode(scope, productId);
}

/**
 * Set a product's transition mode, or the workspace default when `productId` is
 * omitted. `null` reverts a product to inheriting. Callers gate this, and the
 * database gates it again.
 */
export async function setTransitionMode(
  mode: TransitionMode | null,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<TransitionMode> {
  const store = await getStore();
  return store.setTransitionMode(mode, scope, productId);
}

/** Replace the workspace's workflow stages. */
export async function replaceStatuses(
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  const store = await getStore();
  return store.replaceStatuses(stages, scope, productId);
}

/**
 * Parse and validate an untrusted workflow-replacement body: `{ statuses:
 * [{ key?, label }] }`. Requires at least two stages, each with a non-empty
 * label. A caller-supplied `key` is honored when it's a valid, unique slug (so
 * a stage's key stays stable across a rename); otherwise a key is derived from
 * the label. `archived` is reserved for the system status.
 *
 * `allowEmpty` additionally accepts `[]`, which is not a workflow but the
 * signal that a product is giving up its own stages and going back to
 * inheriting the workspace default (see `replaceStatuses`). Only the
 * product-scoped caller passes it: at workspace scope an empty array is far
 * more likely to be a client bug than a request to fall back to the built-in
 * vocabulary, and rejecting it costs a real user nothing.
 */
export function parseStatusStages(
  body: unknown,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): StatusStageInput[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { statuses?: unknown }).statuses;
  if (!Array.isArray(raw)) {
    throw new InvalidPatchError("statuses must be an array.");
  }
  if (allowEmpty && raw.length === 0) return [];
  if (raw.length < 2 || raw.length > 30) {
    throw new InvalidPatchError("A workflow needs between 2 and 30 stages.");
  }
  const taken = new Set<string>();
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidPatchError("Each stage must be an object.");
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) throw new InvalidPatchError("Each stage needs a label.");
    const provided =
      typeof e.key === "string" && /^[a-z0-9_]+$/.test(e.key) ? e.key : null;
    let key =
      provided && provided !== "archived" && !taken.has(provided)
        ? provided
        : propertyKeyFromLabel(label, taken);
    if (key === "archived") key = propertyKeyFromLabel(`${label}_stage`, taken);
    taken.add(key);
    return { key, label };
  });
}

/** The workspace's stage gates (checklist items per stage). */
export async function listStageGates(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<StageGate[]> {
  const store = await getStore();
  return store.listStageGates(scope, productId);
}

/** Replace the workspace's stage gates wholesale (admin action). */
export async function replaceStageGates(
  gates: StageGateInput[],
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<StageGate[]> {
  const store = await getStore();
  return store.replaceStageGates(gates, scope, productId);
}

/**
 * Parse and validate an untrusted stage-gates replacement body: `{ gates:
 * [{ stageKey, label }] }`. Each entry needs a non-empty `stageKey` and a
 * non-empty `label`. Order within a stage is preserved (it becomes the
 * checklist position). An empty array clears all gates.
 */
export function parseStageGates(body: unknown): StageGateInput[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = (body as { gates?: unknown }).gates;
  if (!Array.isArray(raw)) {
    throw new InvalidPatchError("gates must be an array.");
  }
  if (raw.length > 200) {
    throw new InvalidPatchError("Too many stage gates (max 200).");
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new InvalidPatchError("Each gate must be an object.");
    }
    const e = entry as Record<string, unknown>;
    const stageKey = typeof e.stageKey === "string" ? e.stageKey.trim() : "";
    if (!stageKey) throw new InvalidPatchError("Each gate needs a stageKey.");
    const label = typeof e.label === "string" ? e.label.trim() : "";
    if (!label) throw new InvalidPatchError("Each gate needs a label.");
    if (label.length > 200) {
      throw new InvalidPatchError("A gate label is too long (max 200 chars).");
    }
    const gate: StageGateInput = { stageKey, label };
    if (typeof e.id === "string" && e.id) gate.id = e.id;
    return gate;
  });
}

/** The gate ids checked off for one feature. */
export async function listGateCompletions(
  specId: string,
  scope?: WorkspaceScope,
): Promise<string[]> {
  const store = await getStore();
  return store.listGateCompletions(specId, scope);
}

/** Mark a gate complete/incomplete for a feature. Returns the new set. */
export async function setGateCompletion(
  specId: string,
  gateId: string,
  completed: boolean,
  scope?: WorkspaceScope,
): Promise<string[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.setGateCompletion(specId, gateId, completed, scope);
  return store.listGateCompletions(specId, scope);
}
