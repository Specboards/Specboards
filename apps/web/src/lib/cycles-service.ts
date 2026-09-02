import {
  validateCycleDates,
  validateCycleScheduleInput,
} from "@specboards/core";
import { getStore, type WorkspaceScope } from "@/lib/store";
import type {
  CycleGenerateInput,
  CycleInput,
  CyclePatch,
  CycleRecord,
  CycleRolloverResult,
} from "@/lib/store/types";
import { parseDate, parseNotes, parseProductId } from "@/lib/planning-input";
import { InvalidPatchError } from "@/lib/service-errors";

/** Cycles: the recurring time boxes work is scheduled into. */

export async function listCycles(
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const store = await getStore();
  return store.listCycles(scope);
}

export async function createCycle(
  input: CycleInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const store = await getStore();
  return store.createCycle(input, scope);
}

export async function updateCycle(
  id: string,
  patch: CyclePatch,
  scope?: WorkspaceScope,
): Promise<CycleRecord> {
  const store = await getStore();
  return store.updateCycle(id, patch, scope);
}

export async function deleteCycle(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteCycle(id, scope);
}

export async function rolloverCycle(
  fromId: string,
  toId: string,
  scope?: WorkspaceScope,
): Promise<CycleRolloverResult> {
  const store = await getStore();
  return store.rolloverCycle(fromId, toId, scope);
}

export async function generateCycles(
  input: CycleGenerateInput,
  scope?: WorkspaceScope,
): Promise<CycleRecord[]> {
  const store = await getStore();
  return store.generateCycles(input, scope);
}

/**
 * Parse and validate an untrusted generate-schedule POST body. The date and
 * naming rules themselves live in core's `validateCycleScheduleInput`, which
 * the store applies again, so this only has to establish the shape.
 */
export function parseCycleGenerateInput(body: unknown): CycleGenerateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const startDate = parseDate(raw.startDate, "startDate");
  const endDate = parseDate(raw.endDate, "endDate");
  if (!startDate || !endDate) {
    throw new InvalidPatchError("startDate and endDate are required.");
  }
  if (typeof raw.lengthDays !== "number") {
    throw new InvalidPatchError("lengthDays must be a number of days.");
  }
  if (typeof raw.nameTemplate !== "string" || raw.nameTemplate.trim() === "") {
    throw new InvalidPatchError("nameTemplate is required.");
  }
  // Absent means "start at one", which is what a first run wants.
  const startNumber = "startNumber" in raw ? raw.startNumber : 1;
  if (typeof startNumber !== "number") {
    throw new InvalidPatchError("startNumber must be a number.");
  }
  const input: CycleGenerateInput = {
    startDate,
    endDate,
    lengthDays: raw.lengthDays,
    nameTemplate: raw.nameTemplate.trim(),
    startNumber,
  };
  const error = validateCycleScheduleInput(input);
  if (error) throw new InvalidPatchError(error);
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("notes" in raw) input.notes = parseNotes(raw.notes);
  return input;
}

/** Parse and validate an untrusted cycle POST body. */
export function parseCycleInput(body: unknown): CycleInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const startDate = parseDate(raw.startDate, "startDate");
  const endDate = parseDate(raw.endDate, "endDate");
  if (!startDate || !endDate) {
    throw new InvalidPatchError("startDate and endDate are required.");
  }
  const dateError = validateCycleDates(startDate, endDate);
  if (dateError) throw new InvalidPatchError(dateError);
  const input: CycleInput = { name: raw.name.trim(), startDate, endDate };
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("notes" in raw) input.notes = parseNotes(raw.notes);
  return input;
}

/** Parse and validate an untrusted cycle PATCH body. */
export function parseCyclePatch(body: unknown): CyclePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: CyclePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("startDate" in raw) {
    const value = parseDate(raw.startDate, "startDate");
    if (!value) throw new InvalidPatchError("startDate cannot be cleared.");
    patch.startDate = value;
  }
  if ("endDate" in raw) {
    const value = parseDate(raw.endDate, "endDate");
    if (!value) throw new InvalidPatchError("endDate cannot be cleared.");
    patch.endDate = value;
  }
  if ("notes" in raw) patch.notes = parseNotes(raw.notes);
  // Only checked when both ends are in the patch; a patch moving one end is
  // validated by the store against the stored value it leaves alone.
  if (patch.startDate && patch.endDate) {
    const dateError = validateCycleDates(patch.startDate, patch.endDate);
    if (dateError) throw new InvalidPatchError(dateError);
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, productId, startDate, endDate, notes.",
    );
  }
  return patch;
}

// ── Goals ─────────────────────────────────────────────────────────────────
// Thin wrappers plus the untrusted-body parsers. The measurement rules
// (period ordering, target-differs-from-start) live in core so both stores and
// both parsers reject the same thing with the same wording.
