/**
 * Unfinished spec edits, kept so a closed tab does not cost someone an
 * afternoon.
 *
 * An engineer editing a spec has a working tree: they can walk away
 * mid-thought and the file is still there. An in-app author has a browser tab,
 * and every save is a commit, so there is nowhere to put unfinished work.
 *
 * ── Where drafts live, and why ──────────────────────────────────────────────
 * Browser-local, deliberately. The spec asked for this to be settled before
 * building because it is not cheap to change afterwards, so: local storage gets
 * essentially all of the value for the case that actually happens, which is one
 * person, one machine, one interrupted afternoon. Server-side drafts buy
 * switching machines and make an assistant conversation resumable, and neither
 * is a thing this product does yet.
 *
 * What that costs, stated so it is a known limit rather than a surprise: a
 * draft does not follow you to another device, and clearing site data loses it.
 * Both are worth revisiting when the assistant epic lands, which is the point
 * at which the item itself says this should be repriced.
 *
 * What is deliberately NOT done: nothing here ever writes to git. A draft is
 * the author's private working copy, and turning "I stepped away" into a commit
 * in the team's repository would be a worse outcome than losing the text.
 */

/** A draft as stored. */
export interface SpecDraft {
  body: string;
  /** ISO time the draft was last touched, for telling the author how old it is. */
  savedAt: string;
  /**
   * The blob sha the author started from. Lets a restore say whether the spec
   * has moved in git since, which decides whether restoring is safe or is about
   * to overwrite somebody's work.
   */
  baseSha: string | null;
}

/** Namespaced per spec. Drafts are per browser profile, so per user already. */
export function draftKey(specId: string): string {
  return `specboards:draft:${specId}`;
}

/**
 * Whether a stored draft is worth offering back.
 *
 * A draft identical to what is already on screen is not a recovery, it is
 * noise: offering it would train people to dismiss a prompt that matters on the
 * one occasion it does.
 */
export function isDraftWorthOffering(
  draft: SpecDraft | null,
  committedBody: string,
): draft is SpecDraft {
  if (!draft) return false;
  if (typeof draft.body !== "string") return false;
  return draft.body.trim() !== committedBody.trim();
}

/**
 * Whether the spec moved in git since the draft was started.
 *
 * Not a reason to refuse the restore, but a reason to say so: restoring on top
 * of a spec somebody else has since rewritten is exactly the case where an
 * author needs to know before they choose, not after they save.
 */
export function hasMovedSince(draft: SpecDraft, currentSha: string | null): boolean {
  if (!draft.baseSha || !currentSha) return false;
  return draft.baseSha !== currentSha;
}

/** Human age of a draft, for the restore prompt. */
export function draftAge(savedAt: string, now: Date): string {
  const ms = now.getTime() - new Date(savedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  // Floor, not round: half a minute rounding up to "1 minute ago" is a small
  // lie told at the exact moment the author knows how long they have been away.
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Read a draft. Returns null rather than throwing on anything unreadable:
 * storage can be disabled, full, or hold a value written by an older version,
 * and none of those should stop someone editing.
 */
export function readDraft(specId: string): SpecDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(specId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SpecDraft;
    return typeof parsed?.body === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a draft, silently doing nothing when storage refuses. */
export function writeDraft(specId: string, draft: SpecDraft): void {
  try {
    window.localStorage.setItem(draftKey(specId), JSON.stringify(draft));
  } catch {
    // Private mode, or the quota is full. The editor still works; the author
    // just does not get recovery, and an error toast about storage would be
    // noise they cannot act on.
  }
}

/** Forget a draft, once its content is safely committed or deliberately dropped. */
export function clearDraft(specId: string): void {
  try {
    window.localStorage.removeItem(draftKey(specId));
  } catch {
    // As above.
  }
}
