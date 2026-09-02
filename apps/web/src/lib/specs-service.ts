import { isUuid } from "@/lib/uuid";
import { InvalidPatchError } from "@/lib/service-errors";

/**
 * Reading the bodies of `/api/v1/specs` and an item's spec content endpoint.
 *
 * Parsing only. The writing is `@/lib/spec-content`, which commits to git; this
 * is the validation that runs before it, kept apart so the git layer is not
 * also in the business of trusting request shapes.
 */

/** A validated spec-body write: the Markdown, plus an optional commit message. */
interface SpecContentInput {
  content: string;
  message?: string;
  /**
   * Blob sha of the file the editor loaded, guarding against overwriting a
   * change made in git in the meantime. Absent means an unguarded write, which
   * is what a caller with no loaded copy (an agent composing a body) has.
   */
  expectedBlobSha?: string;
}

/**
 * Parse an untrusted spec-content body: `{ content, message? }`.
 *
 * `content` is the Markdown *after* the frontmatter and may legitimately be
 * empty (someone clearing a spec back to a stub), so it is checked for type
 * rather than emptiness. A blank `message` is dropped rather than rejected: the
 * write already falls back to a generated commit message.
 */
export function parseSpecContentInput(body: unknown): SpecContentInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.content !== "string") {
    throw new InvalidPatchError("content is required and must be a string.");
  }
  const input: SpecContentInput = { content: raw.content };
  if ("message" in raw && raw.message !== null && raw.message !== undefined) {
    if (typeof raw.message !== "string") {
      throw new InvalidPatchError("message must be a string.");
    }
    if (raw.message.trim()) input.message = raw.message;
  }
  if (
    "expectedBlobSha" in raw &&
    raw.expectedBlobSha !== null &&
    raw.expectedBlobSha !== undefined
  ) {
    // A blank sha is rejected rather than quietly dropped. Dropping it would
    // turn a write the caller believes is guarded into one that is not, and the
    // point of the guard is that nobody has to wonder which they got.
    if (typeof raw.expectedBlobSha !== "string" || !raw.expectedBlobSha.trim()) {
      throw new InvalidPatchError(
        "expectedBlobSha must be a non-empty string when given.",
      );
    }
    input.expectedBlobSha = raw.expectedBlobSha;
  }
  return input;
}

/**
 * A validated spec-create request. Mirrors `createSpec`'s input, plus
 * `parentSpecId`, which the route applies as a follow-up patch so the caller
 * gets "create it and nest it" as one action.
 */
interface SpecCreateInput {
  title: string;
  body?: string;
  /** Existing leaf work item to attach the spec to (keeps its identity). */
  workItemId?: string;
  /** Card to nest the newly created item under. Not valid when attaching. */
  parentSpecId?: string;
  /** Detail template to start the spec's body from. */
  templateId?: string;
  repoId?: string;
  message?: string;
}

/**
 * Parse an untrusted spec-create body:
 * `{ title, body?, workItemId?, parentSpecId?, repoId?, message? }`.
 *
 * `templateId` is only consulted for a spec that would otherwise be blank, so it
 * is accepted rather than rejected alongside a body: see `resolveTemplateBody`.
 *
 * `workItemId` and `parentSpecId` are mutually exclusive, and the rejection is
 * the point rather than a technicality: attaching a spec to an item that
 * already exists must not move it. That item has a parent, a status and a
 * history someone is relying on, and quietly re-parenting it because the
 * request happened to carry the field would be a silent edit to tracked work.
 * A caller that genuinely wants both does the move itself, visibly.
 */
export function parseSpecCreateInput(body: unknown): SpecCreateInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new InvalidPatchError("title is required and must be a string.");
  }
  const input: SpecCreateInput = { title: raw.title.trim() };

  // The body may legitimately be empty (start from the stub), so this is a type
  // check, not an emptiness one.
  if (raw.body !== null && raw.body !== undefined) {
    if (typeof raw.body !== "string") {
      throw new InvalidPatchError("body must be a string.");
    }
    input.body = raw.body;
  }

  for (const key of ["workItemId", "parentSpecId", "templateId"] as const) {
    if (raw[key] === null || raw[key] === undefined) continue;
    if (!isUuid(raw[key])) {
      throw new InvalidPatchError(`${key} must be a UUID.`);
    }
    input[key] = raw[key] as string;
  }
  if (input.workItemId && input.parentSpecId) {
    throw new InvalidPatchError(
      "Pass workItemId or parentSpecId, not both: attaching a spec to an " +
        "existing item keeps that item where it already is.",
    );
  }

  if (raw.repoId !== null && raw.repoId !== undefined) {
    if (typeof raw.repoId !== "string" || !raw.repoId.trim()) {
      throw new InvalidPatchError("repoId must be a non-empty string.");
    }
    input.repoId = raw.repoId;
  }
  // A blank message is dropped rather than rejected: `createSpec` falls back to
  // a generated commit message.
  if (raw.message !== null && raw.message !== undefined) {
    if (typeof raw.message !== "string") {
      throw new InvalidPatchError("message must be a string.");
    }
    if (raw.message.trim()) input.message = raw.message;
  }
  return input;
}
