import type { IdeaStage } from "@specboards/core";
import { type FeatureRecord, getStore, type WorkspaceScope } from "@/lib/store";
import type {
  IdeaInput,
  IdeaPatch,
  IdeaRecord,
  IdeaSettings,
  IdeaSettingsPatch,
  StatusStageInput,
} from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/** Ideas, their votes, their statuses, and the portal settings that govern them. */

/** The workspace's ideas the acting user can see, most-voted first. */
export async function listIdeas(
  scope?: WorkspaceScope,
): Promise<IdeaRecord[]> {
  const store = await getStore();
  return store.listIdeas(scope);
}

/** Capture a new idea. */
export async function createIdea(
  input: IdeaInput,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return store.createIdea(input, scope);
}

/** Update an idea's title/description/status/product. */
export async function updateIdea(
  id: string,
  patch: IdeaPatch,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return store.updateIdea(id, patch, scope);
}

/** Delete an idea (its votes cascade). */
export async function deleteIdea(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteIdea(id, scope);
}

/** Add or remove the acting user's vote for an idea. */
export async function setIdeaVote(
  id: string,
  voted: boolean,
  scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const store = await getStore();
  return voted ? store.voteIdea(id, scope) : store.unvoteIdea(id, scope);
}

/** Promote an idea into a feature; returns both records. */
export async function promoteIdea(
  id: string,
  scope?: WorkspaceScope,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const store = await getStore();
  return store.promoteIdea(id, scope);
}

/** The workspace's idea review stages, or `[]` when using the built-in default. */
export async function listIdeaStatuses(
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  const store = await getStore();
  return store.listIdeaStatuses(scope);
}

/** Replace the workspace's idea review stages. */
export async function replaceIdeaStatuses(
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  const store = await getStore();
  return store.replaceIdeaStatuses(stages, scope);
}

/** The workspace's Ideas configuration (portal settings). */
export async function getIdeaSettings(
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  const store = await getStore();
  return store.getIdeaSettings(scope);
}

/** Update the workspace's Ideas configuration. */
export async function updateIdeaSettings(
  patch: IdeaSettingsPatch,
  scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  const store = await getStore();
  return store.updateIdeaSettings(patch, scope);
}

/** Parse and validate an untrusted idea-create body. */
export function parseIdeaInput(body: unknown): IdeaInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new InvalidPatchError("title is required.");
  }
  const input: IdeaInput = { title: raw.title.trim() };
  if ("description" in raw) input.description = parseNullableText(raw.description, "description");
  if ("productId" in raw) input.productId = parseNullableId(raw.productId, "productId");
  return input;
}

/** Parse and validate an untrusted idea PATCH body. */
export function parseIdeaPatch(body: unknown): IdeaPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: IdeaPatch = {};
  if ("title" in raw) {
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      throw new InvalidPatchError("title must be a non-empty string.");
    }
    patch.title = raw.title.trim();
  }
  if ("description" in raw) {
    patch.description = parseNullableText(raw.description, "description");
  }
  if ("status" in raw) {
    if (typeof raw.status !== "string" || raw.status.trim() === "") {
      throw new InvalidPatchError("status must be a non-empty string.");
    }
    patch.status = raw.status;
  }
  if ("productId" in raw) {
    patch.productId = parseNullableId(raw.productId, "productId");
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: title, description, status, productId.",
    );
  }
  return patch;
}

/** Parse an untrusted `{ voted: boolean }` body for an idea vote toggle. */
export function parseIdeaVote(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const voted = (body as { voted?: unknown }).voted;
  if (typeof voted !== "boolean") {
    throw new InvalidPatchError("voted must be a boolean.");
  }
  return voted;
}

/** Parse and validate an untrusted Ideas-settings PATCH body. */
export function parseIdeaSettingsPatch(body: unknown): IdeaSettingsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: IdeaSettingsPatch = {};
  if ("portalEnabled" in raw) {
    if (typeof raw.portalEnabled !== "boolean") {
      throw new InvalidPatchError("portalEnabled must be a boolean.");
    }
    patch.portalEnabled = raw.portalEnabled;
  }
  if ("portalTitle" in raw) {
    patch.portalTitle = parseNullableText(raw.portalTitle, "portalTitle");
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: portalEnabled, portalTitle.",
    );
  }
  return patch;
}

function parseNullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError(`${field} must be a string or null.`);
  }
  return value;
}

function parseNullableId(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError(`${field} must be a string id or null.`);
  }
  return value;
}
