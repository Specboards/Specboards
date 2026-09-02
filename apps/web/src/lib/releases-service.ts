import { notifyOutbox } from "@/lib/webhooks/events";
import { getStore, type OutboxEmit, type WorkspaceScope } from "@/lib/store";
import {
  RELEASE_NOTES_MODES,
  RELEASE_STATUSES,
  type ReleaseInput,
  type ReleaseNotesMode,
  type ReleasePatch,
  type ReleaseRecord,
  type ReleaseStatus,
} from "@/lib/store/types";
import { assertCustomFieldTypes, parseCustomFields } from "@/lib/custom-fields";
import { parseDate, parseNotes, parseProductId } from "@/lib/planning-input";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * Releases, including the customer-facing release notes.
 *
 * Which release an item belongs to is not set here. That is a field on the item
 * and is written through `patchFeature`, so a scheduling change is subject to
 * the same transition and gate rules as any other edit to the card. This module
 * owns the release itself: its name, dates, status, and notes.
 */

/**
 * Keep a release's ship date on or after its start date by pulling the ship date
 * along when the start moves past it.
 *
 * A ship date earlier than the start is never a plan anyone means, so pushing a
 * release out should not also require re-picking its end: the invariant is
 * maintained here rather than rejected, which is what makes moving a release a
 * single edit. Only a patch that moves the start can trigger it, and only
 * against the ship date the release will actually have (the patch's own, or the
 * stored one it leaves alone), so a patch that sets both dates is respected as
 * written unless it is itself backwards.
 *
 * Lives in the service, not the form, so the REST API and the MCP tools hold the
 * same invariant the UI does. Dates are validated as `YYYY-MM-DD` upstream
 * (parseDate), which is why they compare as strings.
 */
export function clampReleaseTarget(
  patch: ReleasePatch,
  before: { targetDate: string | null } | null,
): ReleasePatch {
  const start = patch.startDate;
  if (!start) return patch;
  const target =
    patch.targetDate !== undefined ? patch.targetDate : before?.targetDate ?? null;
  if (!target || target >= start) return patch;
  return { ...patch, targetDate: start };
}

/** Create a release. */
export async function createRelease(
  input: ReleaseInput,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();
  if (input.customFields && Object.keys(input.customFields).length > 0) {
    const properties = await store.listProperties(scope, "release");
    assertCustomFieldTypes(input.customFields, properties);
  }
  // Same invariant as an edit: a release cannot be born ending before it starts.
  const dates = clampReleaseTarget(
    { startDate: input.startDate, targetDate: input.targetDate },
    null,
  );
  return store.createRelease({ ...input, ...dates }, scope);
}

/** Update a release. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
  scope?: WorkspaceScope,
): Promise<ReleaseRecord> {
  const store = await getStore();

  // Type-check release custom-field values against their release-scoped property
  // definitions (date fields must be real ISO dates), mirroring patchFeature.
  // Skipped when no custom fields are being written.
  if (patch.customFields && Object.keys(patch.customFields).length > 0) {
    const properties = await store.listProperties(scope, "release");
    assertCustomFieldTypes(patch.customFields, properties);
  }

  // Capture the prior status so we can detect the ship edge for the webhook.
  const before = (await store.listReleases(scope)).find((r) => r.id === id) ?? null;

  // A start moved past the ship date takes the ship date with it, so the two can
  // never end up in the wrong order. Applied before the webhook payload is built
  // so an event reports the dates the release actually lands on.
  const effective = clampReleaseTarget(patch, before);

  // Record release.shipped in the same transaction as the ship. A ship patch is
  // status-only in practice; apply any name/date overrides in the patch so the
  // payload reflects the post-update release (itemCount is unaffected by status).
  let emit: OutboxEmit | undefined;
  if (before && before.status !== "shipped" && effective.status === "shipped") {
    emit = {
      type: "release.shipped",
      // A product release scopes its event to that product; a portfolio
      // release (null productId) stays workspace-level.
      productId:
        effective.productId !== undefined ? effective.productId : before.productId,
      data: {
        releaseId: before.id,
        name: effective.name?.trim() || before.name,
        startDate:
          effective.startDate !== undefined
            ? effective.startDate
            : before.startDate,
        targetDate:
          effective.targetDate !== undefined
            ? effective.targetDate
            : before.targetDate,
        itemCount: before.itemCount,
      },
    };
  }

  const updated = await store.updateRelease(id, effective, scope, emit);
  if (emit) notifyOutbox();

  return updated;
}

/** Delete a release; its items are unscheduled, not deleted. */
export async function deleteRelease(
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteRelease(id, scope);
}

/** The workspace's releases, dated first, undated last. */
export async function listReleases(
  scope?: WorkspaceScope,
): Promise<ReleaseRecord[]> {
  const store = await getStore();
  return store.listReleases(scope);
}

/** Parse and validate an untrusted release-create body. */
export function parseReleaseInput(body: unknown): ReleaseInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new InvalidPatchError("name is required.");
  }
  const input: ReleaseInput = { name: raw.name.trim() };
  if ("productId" in raw) input.productId = parseProductId(raw.productId);
  if ("status" in raw) input.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) input.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) input.targetDate = parseDate(raw.targetDate, "targetDate");
  if ("shippedDate" in raw)
    input.shippedDate = parseDate(raw.shippedDate, "shippedDate");
  if ("notes" in raw) input.notes = parseNotes(raw.notes);
  if ("releaseNotesMode" in raw)
    input.releaseNotesMode = parseReleaseNotesMode(raw.releaseNotesMode);
  if ("releaseNotesBody" in raw)
    input.releaseNotesBody = parseReleaseNotesBody(raw.releaseNotesBody);
  if ("releaseNotesUrl" in raw)
    input.releaseNotesUrl = parseReleaseNotesUrl(raw.releaseNotesUrl);
  if ("customFields" in raw)
    input.customFields = parseCustomFields(raw.customFields);
  return input;
}

/** Parse and validate an untrusted release PATCH body. */
export function parseReleasePatch(body: unknown): ReleasePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ReleasePatch = {};
  if ("name" in raw) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidPatchError("name must be a non-empty string.");
    }
    patch.name = raw.name.trim();
  }
  if ("productId" in raw) patch.productId = parseProductId(raw.productId);
  if ("status" in raw) patch.status = parseReleaseStatus(raw.status);
  if ("startDate" in raw) patch.startDate = parseDate(raw.startDate, "startDate");
  if ("targetDate" in raw) patch.targetDate = parseDate(raw.targetDate, "targetDate");
  if ("shippedDate" in raw)
    patch.shippedDate = parseDate(raw.shippedDate, "shippedDate");
  if ("notes" in raw) patch.notes = parseNotes(raw.notes);
  if ("releaseNotesMode" in raw)
    patch.releaseNotesMode = parseReleaseNotesMode(raw.releaseNotesMode);
  if ("releaseNotesBody" in raw)
    patch.releaseNotesBody = parseReleaseNotesBody(raw.releaseNotesBody);
  if ("releaseNotesUrl" in raw)
    patch.releaseNotesUrl = parseReleaseNotesUrl(raw.releaseNotesUrl);
  if ("customFields" in raw)
    patch.customFields = parseCustomFields(raw.customFields);
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Patch must set at least one of: name, productId, status, " +
        "startDate, targetDate, shippedDate, notes, releaseNotesMode, " +
        "releaseNotesBody, releaseNotesUrl, customFields.",
    );
  }
  return patch;
}

// ── Cycles ────────────────────────────────────────────────────────────────
// Thin service wrappers, mirroring the release ones. Cycles carry no derived
// invariant of their own the way releases do (clampReleaseTarget): the
// start/end ordering is enforced by validateCycleDates in core, so both stores
// and both parsers reject the same thing with the same wording.

/** Validate the customer-facing release-notes mode: none | in_app | external. */
function parseReleaseNotesMode(value: unknown): ReleaseNotesMode {
  if (
    typeof value !== "string" ||
    !(RELEASE_NOTES_MODES as readonly string[]).includes(value)
  ) {
    throw new InvalidPatchError(
      `releaseNotesMode must be one of: ${RELEASE_NOTES_MODES.join(", ")}.`,
    );
  }
  return value as ReleaseNotesMode;
}

/** Validate in-app release-notes body: a string (trimmed; empty → null) or null. */
function parseReleaseNotesBody(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("releaseNotesBody must be a string or null.");
  }
  const trimmed = value.trim();
  if (trimmed.length > 50_000) {
    throw new InvalidPatchError(
      "releaseNotesBody must be 50,000 characters or fewer.",
    );
  }
  return trimmed || null;
}

/**
 * Validate an external release-notes URL: a string (trimmed; empty → null) or
 * null. Only http(s) URLs are accepted so the app never links out to a
 * `javascript:` or other scheme.
 */
function parseReleaseNotesUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new InvalidPatchError("releaseNotesUrl must be a string or null.");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2_048) {
    throw new InvalidPatchError(
      "releaseNotesUrl must be 2,048 characters or fewer.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidPatchError("releaseNotesUrl must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidPatchError("releaseNotesUrl must be an http(s) URL.");
  }
  return trimmed;
}

/**
 * Parse a customer-facing release-notes-only patch, for the `update_release_notes`
 * MCP tool. Returns a `ReleasePatch` limited to the `releaseNotes*` fields, so a
 * caller can author the notes without being able to touch a release's name,
 * status, dates, product, or the internal planning `notes`.
 *
 * `mode` may be given explicitly; when it isn't, it is inferred from the payload:
 * a non-empty `body` implies `in_app`, a non-empty `url` implies `external`, and
 * clearing the payload (empty/null body or url with no mode) implies `none`. The
 * stored body and url are retained across mode switches, so setting one mode
 * never clobbers the other's value.
 */
export function parseReleaseNotesPatch(body: unknown): ReleasePatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  const patch: ReleasePatch = {};
  let mode: ReleaseNotesMode | undefined;
  if ("mode" in raw) mode = parseReleaseNotesMode(raw.mode);
  if ("body" in raw) patch.releaseNotesBody = parseReleaseNotesBody(raw.body);
  if ("url" in raw) patch.releaseNotesUrl = parseReleaseNotesUrl(raw.url);
  if (patch.releaseNotesBody !== undefined && patch.releaseNotesUrl) {
    throw new InvalidPatchError(
      "Provide an in-app `body` or an external `url`, not both.",
    );
  }
  // Infer the mode from the payload when it wasn't set explicitly.
  if (mode === undefined) {
    if (patch.releaseNotesBody) mode = "in_app";
    else if (patch.releaseNotesUrl) mode = "external";
    else if ("body" in raw || "url" in raw) mode = "none";
  }
  if (mode !== undefined) patch.releaseNotesMode = mode;
  if (Object.keys(patch).length === 0) {
    throw new InvalidPatchError(
      "Provide at least one of: mode, body, url.",
    );
  }
  return patch;
}

function parseReleaseStatus(value: unknown): ReleaseStatus {
  if (
    typeof value !== "string" ||
    !(RELEASE_STATUSES as readonly string[]).includes(value)
  ) {
    throw new InvalidPatchError(
      `status must be one of: ${RELEASE_STATUSES.join(", ")}.`,
    );
  }
  return value as ReleaseStatus;
}
