import { getStore, type WorkspaceScope } from "@/lib/store";
import type {
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
} from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * The detail templates that pre-fill a new item's body.
 *
 * Separate from `levels-service` even though a level points at a template: the
 * template is authored and reused on its own, and the two endpoints have
 * nothing in common beyond that reference.
 */

/** The workspace's detail templates, ordered by name. */
export async function listDetailTemplates(
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<DetailTemplate[]> {
  const store = await getStore();
  return store.listDetailTemplates(scope, productId);
}

/** Parse and validate an untrusted detail-template-create body. */
export function parseDetailTemplateInput(body: unknown): DetailTemplateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const body_ = "body" in raw ? raw.body : "";
  if (typeof body_ !== "string") {
    throw new InvalidPatchError("body must be a string.");
  }
  if (body_.length > 100_000) {
    throw new InvalidPatchError("body is too long.");
  }
  return { name: raw.name.trim(), body: body_ };
}

/** Parse and validate an untrusted detail-template PATCH body. */
export function parseDetailTemplatePatch(body: unknown): DetailTemplatePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: DetailTemplatePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("body" in raw) {
    if (typeof raw.body !== "string") {
      throw new InvalidPatchError("body must be a string.");
    }
    if (raw.body.length > 100_000) {
      throw new InvalidPatchError("body is too long.");
    }
    patch.body = raw.body;
  }
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError("Patch must set at least one of: name, body.");
  }
  return patch;
}

/** Create a detail template. */
export async function createDetailTemplate(
  input: DetailTemplateInput,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<DetailTemplate> {
  const store = await getStore();
  return store.createDetailTemplate(input, scope, productId);
}

/** Update a detail template. */
export async function updateDetailTemplate(
  id: string,
  patch: DetailTemplatePatch,
  scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  const store = await getStore();
  return store.updateDetailTemplate(id, patch, scope);
}

/** Delete a detail template. */
export async function deleteDetailTemplate(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteDetailTemplate(id, scope);
}
