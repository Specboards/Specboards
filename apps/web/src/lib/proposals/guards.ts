import { bodyFitsWhole } from "@/lib/ai/item-context";
import { notesFitWhole } from "@/lib/ai/release-context";
import { contentVersion } from "@/lib/assistant-service";

import { ProposalStaleError, ProposalTooLongError } from "./errors";

/**
 * The two checks that run before a proposal is claimed.
 *
 * Before, and not after, so a refused apply leaves the proposal exactly as it
 * was rather than needing to be un-claimed. That ordering is the whole reason
 * these are separable functions and not inlined at the two call sites.
 *
 * Moved out of `lib/assistant-proposals.ts` unchanged. One definition, used by
 * the assistant path and the harness path, so a rule cannot hold on one route
 * and not the other.
 */

/** What the subject is called in the message a person reads. */
type GuardSubject = "item" | "release";

/**
 * Refuse an apply whose document could not have been sent to the model whole.
 *
 * Belt and braces beside the persist-time refusal, and not redundant with it:
 * an apply can happen a day later, and a description that fitted when the
 * draft was made may not fit now. The rule is one predicate used in three
 * places, so the prompt, the record and the apply cannot disagree about it.
 */
export function assertSentWhole(fits: boolean, subject: GuardSubject): void {
  if (fits) return;
  throw new ProposalTooLongError(
    subject === "item"
      ? "This item's description is too long to send to the model in full, so a " +
        "suggested rewrite cannot be applied: it would delete everything past " +
        "the point the assistant could see. Shorten the description, or edit it " +
        "directly."
      : "These release notes are too long to send to the model in full, so a " +
        "suggested rewrite cannot be applied: it would delete everything past " +
        "the point the assistant could see. Shorten the notes, or edit them " +
        "directly.",
  );
}

/**
 * Refuse an apply whose base no longer matches what is there now.
 *
 * A git-backed spec does not come through here: it has a blob sha and goes
 * down the guarded, merged write path instead, which can three-way merge
 * rather than simply refuse. This is for the subjects that have no blob, where
 * the only honest options are "apply blindly" and "stop and show them".
 *
 * `null` recorded means the proposal predates this guard. Those are allowed
 * through rather than refused: refusing would break every draft already
 * sitting on a card, to protect against a race that has probably not happened.
 */
export function assertNotStale(
  recordedBase: string | null,
  currentBody: string,
  subject: GuardSubject,
): void {
  if (recordedBase === null) return;
  if (recordedBase === contentVersion(currentBody)) return;
  throw new ProposalStaleError(
    subject === "item"
      ? "This item's description changed after the assistant drafted this, so " +
        "accepting would replace that newer version. Review the current text " +
        "and ask again if the change is still wanted."
      : "These release notes changed after the assistant drafted this, so " +
        "accepting would replace that newer version. Review the current notes " +
        "and ask again if the change is still wanted.",
    currentBody,
  );
}

/**
 * Order-independent JSON, so a hash means "these values" and not "these
 * values, serialised in this order".
 *
 * Object keys and array members both get sorted. Tags are the case that forces
 * it: the same three tags coming back in a different order from one read to
 * the next would read as a change, and every metadata proposal against that
 * item would then be refused as stale forever.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (typeof value === "object" && value !== null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = stable(src[key]);
    return out;
  }
  return value ?? null;
}

/**
 * A fingerprint of just the fields a metadata proposal intends to change.
 *
 * Narrow on purpose. Fingerprinting the whole item would mean a proposal to
 * add a tag went stale because somebody else changed the assignee, which is
 * two people not colliding being told that they did. The question a staleness
 * guard should ask is whether the ground *under this change* moved.
 */
export function metadataVersion(
  feature: object,
  fields: readonly string[],
): string {
  // `object` rather than an index signature, so a caller can pass the typed
  // FeatureDetail it already holds. The fields are a fixed list from
  // `types.ts`, not caller-supplied strings, so the lookup is as safe as a
  // property access would be.
  const src = feature as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const field of [...fields].sort()) {
    snapshot[field] = stable(src[field]);
  }
  return contentVersion(JSON.stringify(snapshot));
}

/**
 * Refuse a metadata change set whose fields have moved since it was drafted.
 *
 * The case this exists for: an agent proposes moving an item to `ready`,
 * nobody looks at the queue for two days, and in the meantime the work shipped
 * and somebody moved it to `done`. Applying then walks the board backwards,
 * quietly, and the board lying is the thing the harness is supposed to fix.
 *
 * `null` recorded is allowed through, matching {@link assertNotStale}: a row
 * that predates the guard should not become unapplicable because the guard
 * arrived.
 */
export function assertMetadataNotStale(
  recordedBase: string | null,
  feature: object,
  fields: readonly string[],
): void {
  if (recordedBase === null) return;
  const current = metadataVersion(feature, fields);
  if (recordedBase === current) return;

  const src = feature as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const field of [...fields].sort()) snapshot[field] = src[field] ?? null;
  throw new ProposalStaleError(
    "This item changed after the proposal was drafted, so applying it would " +
      "overwrite that newer state. Review where the item is now and ask again " +
      "if the change is still wanted.",
    JSON.stringify(snapshot, null, 2),
  );
}

export { bodyFitsWhole, notesFitWhole };
