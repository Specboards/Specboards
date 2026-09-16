/**
 * What a proposal is, and how an untrusted one is read.
 *
 * A proposal row's `payload` is jsonb written by whatever drafted it, which
 * increasingly means an agent we did not write talking to the MCP server. So
 * every shape in here is parsed rather than cast: the parsers below are the
 * only way a payload becomes a typed value, and they are the boundary where a
 * malformed or hostile one is refused.
 *
 * Pure: no database, no network, no environment. The same rule `lib/ai/proposals.ts`
 * and `lib/ai/breakdown.ts` follow, and for the same reason: the parse has to
 * be testable without standing anything up, and usable on both sides of the
 * wire without dragging a connection along with it.
 */

/** Where a proposal was made, which decides which surface renders it. */
export type ProposalOrigin = "conversation" | "run";

/** What kind of change is being proposed. */
export type ProposalKind =
  | "spec_content"
  | "item_metadata"
  | "item_batch"
  | "doc_draft";

/** What the proposal is against. */
export type ProposalTargetType = "feature" | "release" | "doc_space";

/**
 * Lifecycle. `superseded` is written by the system, not a person: a later
 * proposal against the same target made this one moot, and marking it that way
 * says so without claiming anybody decided against it.
 */
/**
 * Where a proposal is in its life.
 *
 * `applying` is the one that needs explaining: it means somebody claimed the
 * proposal and the write to the target was started. It is not a second kind
 * of `open` (the decision is made, and nobody else may claim it) and it is
 * not `applied` (the write may not have landed). A process that dies mid-apply
 * leaves this, which is the truth, where it used to leave `applied`, which was
 * not. See migration 0018.
 */
export type ProposalStatus =
  | "open"
  | "applying"
  | "applied"
  | "dismissed"
  | "superseded";

/** Mirrors the actor model the event ledger already uses. */
export type ProposalActorType = "user" | "agent" | "api_key" | "system";

/**
 * Most citations one proposal may carry.
 *
 * The same backstop as `MAX_PROPOSED_CHILDREN`, for the same failure: a model
 * that misreads "cite your sources" and starts enumerating can otherwise put a
 * wall of links in front of somebody, and the reviewer's job is to read them.
 * A proposal that genuinely rests on more than twenty sources needs a summary,
 * not a longer list.
 */
export const MAX_EVIDENCE = 20;

/** Longest a single evidence label may be, so one cannot swamp the row. */
const MAX_EVIDENCE_LABEL_CHARS = 200;

/**
 * Where a claim came from.
 *
 * Internal kinds carry the id of something in this workspace and render as an
 * in-app link. `url` is the escape hatch for a connected agent that read the
 * web, and it renders with its host visible: the reader should be able to see
 * that a claim rests on a vendor's own marketing page before they click it.
 */
export type EvidenceKind = "idea" | "comment" | "item" | "doc" | "url";

export interface Evidence {
  kind: EvidenceKind;
  /** An id for an internal kind, an absolute http(s) URL for `url`. */
  ref: string;
  /** What to show. Falls back to the ref when a drafter gave nothing. */
  label: string;
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "idea",
  "comment",
  "item",
  "doc",
  "url",
];

/** A payload that could not be read. Callers map this to 422. */
export class ProposalPayloadError extends Error {}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Read an evidence list, dropping what cannot be understood.
 *
 * Lenient on purpose, and asymmetric with the payload parsers below, which
 * refuse. A proposal whose *content* cannot be read is not reviewable and has
 * to be rejected. A proposal whose fourth citation is malformed is still a
 * perfectly reviewable proposal with three citations, and throwing it away
 * over a bad link would be the tail wagging the dog.
 */
export function parseEvidence(raw: unknown): Evidence[] {
  if (!Array.isArray(raw)) return [];
  const out: Evidence[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_EVIDENCE) break;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const kind = str(e.kind);
    const ref = str(e.ref);
    if (!kind || !ref) continue;
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) continue;
    // An external citation that is not a URL is not a citation. Refusing the
    // entry rather than rendering unclickable text keeps "this is a link" true
    // of every `url` row the reader sees.
    if (kind === "url" && !/^https?:\/\//i.test(ref)) continue;
    out.push({
      kind: kind as EvidenceKind,
      ref,
      label: (str(e.label) ?? ref).slice(0, MAX_EVIDENCE_LABEL_CHARS),
    });
  }
  return out;
}

/** A whole replacement body for an item's description, a spec, or release notes. */
interface SpecContentPayload {
  body: string;
}

/**
 * The metadata fields an agent may propose changing.
 *
 * Deliberately a list rather than "whatever `FeaturePatch` accepts". A patch
 * type grows when somebody adds a column, and a proposal payload growing the
 * same way, silently, is how an agent ends up able to propose a field nobody
 * decided it should touch. Adding one here is a decision.
 *
 * `details` is absent: the body is `spec_content`'s job, and two kinds able to
 * write the same text would be two things to keep in step.
 */
export interface ItemMetadataPayload {
  title?: string;
  /**
   * A stage change.
   *
   * Allowed, and the loudest thing on this list. Applying one can fire stage
   * gates, notifications and outbox events, so it is a bigger blast radius
   * than proposing a tag. The decision (2026-09-15) was to allow it and make
   * the review row say what will fire, rather than to forbid it: an agent that
   * has finished the work and cannot say so leaves the board lying, which is
   * the thing the harness exists to fix.
   */
  status?: string;
  tags?: string[];
  assigneeId?: string | null;
  releaseId?: string | null;
  cycleId?: string | null;
  parentSpecId?: string | null;
  customFields?: Record<string, unknown>;
}

/** Fields `parseItemMetadata` will read, and nothing else. */
const METADATA_FIELDS = [
  "title",
  "status",
  "tags",
  "assigneeId",
  "releaseId",
  "cycleId",
  "parentSpecId",
  "customFields",
] as const;

export function parseSpecContent(raw: unknown): SpecContentPayload {
  const body = typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>).body
    : undefined;
  if (typeof body !== "string" || body.trim() === "") {
    throw new ProposalPayloadError(
      "This proposal has no replacement text, so there is nothing to apply.",
    );
  }
  return { body };
}

/**
 * Read a metadata change set.
 *
 * Unknown keys are dropped rather than refused, so a newer agent talking to an
 * older server degrades to proposing the fields this server understands
 * instead of failing outright. An empty result *is* refused: a change set that
 * changes nothing is a reviewer being asked to approve a no-op, and the honest
 * answer is that the proposal was malformed.
 */
export function parseItemMetadata(raw: unknown): ItemMetadataPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new ProposalPayloadError("This proposal's change set is unreadable.");
  }
  const src = raw as Record<string, unknown>;
  const out: ItemMetadataPayload = {};

  for (const field of METADATA_FIELDS) {
    if (!(field in src)) continue;
    const v = src[field];
    switch (field) {
      case "title": {
        const t = str(v);
        if (t) out.title = t;
        break;
      }
      case "status": {
        const s = str(v);
        if (s) out.status = s;
        break;
      }
      case "tags": {
        if (Array.isArray(v)) {
          const tags = v.filter((x): x is string => typeof x === "string");
          // A tag list is replaced wholesale, so an empty array is a real
          // instruction ("clear the tags") and not the same as omitting it.
          out.tags = tags;
        }
        break;
      }
      case "customFields": {
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          out.customFields = v as Record<string, unknown>;
        }
        break;
      }
      // The nullable references. `null` is meaningful on every one of them
      // (unassign, unschedule, unparent), so it passes through where an
      // unreadable value is dropped.
      default: {
        if (v === null || typeof v === "string") {
          out[field] = v as never;
        }
        break;
      }
    }
  }

  if (Object.keys(out).length === 0) {
    throw new ProposalPayloadError(
      "This proposal does not change anything readable on the item.",
    );
  }
  return out;
}

/**
 * The fields of a metadata change set that are worth warning a reviewer about
 * before they apply it, in the order they should be shown.
 *
 * Only `status` for now. This exists as a list rather than an `if` because the
 * decision to allow stage changes came with a promise to surface what they
 * fire, and the next field that earns a warning should land next to that
 * promise rather than in a second place.
 */
export function consequencesOf(patch: ItemMetadataPayload): string[] {
  const out: string[] = [];
  if (patch.status !== undefined) {
    out.push(
      "Changes the stage, which can run stage gates and notify watchers.",
    );
  }
  return out;
}
