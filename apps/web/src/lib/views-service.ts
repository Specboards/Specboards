import { FILTER_KEYS } from "@/lib/feature-filters";
import {
  getStore,
  type SavedView,
  type SavedViewInput,
  type WorkspaceScope,
} from "@/lib/store";
import type { SavedViewFilters, SavedViewPatch } from "@/lib/store/types";

/**
 * Domain operations for saved views behind /api/v1/views. Mirrors
 * features-service: thin routes, validation + store access here.
 */

export class InvalidViewError extends Error {}

const MAX_NAME_LEN = 80;
const ALLOWED_VIEWS = new Set(["backlog"]);
const ALLOWED_FILTER_KEYS = new Set<string>(FILTER_KEYS);

/** Parse and validate an untrusted saved-view create body. */
export function parseSavedViewInput(body: unknown): SavedViewInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidViewError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidViewError("name must be a non-empty string.");
  }
  const name = raw.name.trim();
  if (name.length > MAX_NAME_LEN) {
    throw new InvalidViewError(`name must be ${MAX_NAME_LEN} characters or fewer.`);
  }

  const view = raw.view === undefined ? "backlog" : raw.view;
  if (typeof view !== "string" || !ALLOWED_VIEWS.has(view)) {
    throw new InvalidViewError(`view must be one of: ${[...ALLOWED_VIEWS].join(", ")}.`);
  }

  return { name, view, filters: parseFilters(raw.filters) };
}

/**
 * Parse and validate an untrusted saved-view patch body: an object with an
 * optional `name` and/or `filters`. At least one must be present. `view` is
 * immutable, so it is rejected if supplied.
 */
export function parseSavedViewPatch(body: unknown): SavedViewPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidViewError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if ("view" in raw) {
    throw new InvalidViewError("A saved view's list (view) cannot be changed.");
  }
  const patch: SavedViewPatch = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidViewError("name must be a non-empty string.");
    }
    const name = raw.name.trim();
    if (name.length > MAX_NAME_LEN) {
      throw new InvalidViewError(`name must be ${MAX_NAME_LEN} characters or fewer.`);
    }
    patch.name = name;
  }

  if (raw.filters !== undefined) {
    patch.filters = parseFilters(raw.filters);
  }

  if (patch.name === undefined && patch.filters === undefined) {
    throw new InvalidViewError("Provide at least one of name or filters to update.");
  }
  return patch;
}

/**
 * Validate the filter bundle: only known keys, and either a list of strings
 * (what a dimension holds now that it accepts several values) or a bare
 * string/number, which is the shape views saved before that still carry and
 * which an API client may reasonably still send.
 */
function parseFilters(value: unknown): SavedViewFilters {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidViewError("filters must be a JSON object.");
  }
  const out: SavedViewFilters = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_FILTER_KEYS.has(key)) {
      throw new InvalidViewError(`Unknown filter key: ${key}.`);
    }
    if (typeof raw === "string" || typeof raw === "number") {
      out[key] = raw;
    } else if (Array.isArray(raw)) {
      if (!raw.every((entry) => typeof entry === "string")) {
        throw new InvalidViewError(`filters.${key} must be a list of strings.`);
      }
      out[key] = raw as string[];
    } else {
      throw new InvalidViewError(
        `filters.${key} must be a string, a number, or a list of strings.`,
      );
    }
  }
  return out;
}

export async function listSavedViews(
  scope?: WorkspaceScope,
): Promise<SavedView[]> {
  const store = await getStore();
  return store.listSavedViews(scope);
}

export async function createSavedView(
  input: SavedViewInput,
  scope?: WorkspaceScope,
): Promise<SavedView> {
  const store = await getStore();
  return store.createSavedView(input, scope);
}

export async function updateSavedView(
  id: string,
  patch: SavedViewPatch,
  scope?: WorkspaceScope,
): Promise<SavedView | null> {
  const store = await getStore();
  return store.updateSavedView(id, patch, scope);
}

export async function deleteSavedView(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteSavedView(id, scope);
}
