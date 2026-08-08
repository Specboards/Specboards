import { statusLabel } from "@/lib/feature-helpers";
import type { ActorType, ItemEvent } from "@/lib/store/types";
import type { StatusWorkflow } from "@specboards/core";

/**
 * Turning a ledger row into a sentence someone can read.
 *
 * The ledger stores ids and status keys, because those are what revert and
 * reporting need. Nobody wants to read them. "Jane moved this from Ready to In
 * Progress" is the change log; `status: "ready" -> "in_progress"` is the row it
 * came from, and showing the row is the same mistake as telling an author their
 * change is on branch `specboards/spec-x`.
 *
 * Resolution is deliberately forgiving. A release that was later deleted, or a
 * teammate who has left, still has to render: the history is most valuable
 * precisely when it refers to things that are gone, and an entry that renders
 * as "undefined" is worse than one that names an id.
 */

/** What ids in the ledger mean, as the reader's workspace currently sees them. */
export interface HistoryContext {
  workflow?: StatusWorkflow;
  members: { userId: string; name: string }[];
  releases: { id: string; name: string }[];
  cycles: { id: string; name: string }[];
}

/** One history entry, ready to render. */
export interface HistoryEntry {
  id: string;
  /** Who made the change, already allowing for automations. */
  actor: string;
  /** What they did, without the actor: "moved this from Ready to In Progress". */
  action: string;
  createdAt: string;
  /** True when something other than a person made the change. */
  automated: boolean;
}

/** What each stored field is called in prose. Shared with activity reporting. */
export const FIELD_LABELS: Record<string, string> = {
  title: "title",
  status: "status",
  tags: "tags",
  releaseId: "release",
  cycleId: "cycle",
  assigneeId: "assignee",
  customFields: "properties",
  details: "description",
  parentId: "parent",
  riceReach: "RICE reach",
  riceImpact: "RICE impact",
  riceConfidence: "RICE confidence",
  riceEffort: "RICE effort",
};

/**
 * Name the actor.
 *
 * An API key belongs to a person, so the honest phrasing credits them and says
 * it was not them typing. "Release bot" alone would hide who is accountable;
 * the owner's name alone would claim they did something they did not.
 */
export function describeActor(event: {
  actorType: ActorType;
  actorLabel: string | null;
}): { actor: string; automated: boolean } {
  const named = event.actorLabel?.trim();
  switch (event.actorType) {
    case "user":
      return { actor: named || "Someone", automated: false };
    case "api_key":
    case "agent":
      return { actor: named ? `${named} (automation)` : "An automation", automated: true };
    case "sync":
      return { actor: named ? `${named} (via git)` : "A change in git", automated: true };
    default:
      return { actor: named || "Specboards", automated: true };
  }
}

function name(list: { id: string; name: string }[], id: unknown): string | null {
  if (typeof id !== "string") return null;
  return list.find((r) => r.id === id)?.name ?? null;
}

/** Render one stored value for reading, or null when there was no value. */
function renderValue(
  field: string,
  value: unknown,
  ctx: HistoryContext,
): string | null {
  if (value === null || value === undefined) return null;
  switch (field) {
    case "status":
      return typeof value === "string" ? statusLabel(value, ctx.workflow) : null;
    case "assigneeId": {
      const member = ctx.members.find((m) => m.userId === value);
      // A departed teammate still has to render as something.
      return member?.name ?? "someone no longer in the workspace";
    }
    case "releaseId":
      return name(ctx.releases, value) ?? "a release that no longer exists";
    case "cycleId":
      return name(ctx.cycles, value) ?? "a cycle that no longer exists";
    case "title":
      return typeof value === "string" ? `"${value}"` : null;
    default:
      if (typeof value === "string") return value || null;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return null;
  }
}

/**
 * What actually changed about a tag list.
 *
 * Phrased per case rather than by appending a suffix, because one suffix cannot
 * serve both directions: "removed a to the tags" is what that shortcut
 * produces.
 */
function describeTags(before: unknown, after: unknown): string {
  const prev = Array.isArray(before) ? before.map(String) : [];
  const next = Array.isArray(after) ? after.map(String) : [];
  const added = next.filter((t) => !prev.includes(t));
  const removed = prev.filter((t) => !next.includes(t));
  const plural = (n: number) => (n === 1 ? "tag" : "tags");

  if (added.length && removed.length) {
    return `added ${added.join(", ")} and removed ${removed.join(", ")}`;
  }
  if (added.length) return `added the ${plural(added.length)} ${added.join(", ")}`;
  if (removed.length) return `removed the ${plural(removed.length)} ${removed.join(", ")}`;
  // Reordered with nothing added or removed. The row exists, so say something
  // true rather than inventing a change.
  return "changed the tags";
}

/**
 * Describe what changed, without naming the actor.
 *
 * Long text is described rather than quoted. A description edit is not
 * readable as a before-and-after in a list, and pasting two paragraphs into a
 * history entry makes the entries around it unfindable.
 */
export function describeChange(event: ItemEvent, ctx: HistoryContext): string {
  // Events that describe the document rather than one of its fields. These
  // carry no `field`, so the field-driven wording below would produce
  // "changed the " with nothing after it.
  if (event.type === "spec.body_changed") return "rewrote the spec";
  if (event.type === "spec.moved") {
    const from = typeof event.before === "string" ? event.before : null;
    const to = typeof event.after === "string" ? event.after : null;
    return from && to ? `moved the spec from ${from} to ${to}` : "moved the spec";
  }

  const field = event.field ?? "";
  const label = FIELD_LABELS[field] ?? field;

  if (field === "tags") return describeTags(event.before, event.after);
  if (field === "details") return "edited the description";
  if (field === "customFields") return "changed the properties";
  if (field === "parentId") {
    return event.after === null ? "removed this from its parent" : "moved this under another item";
  }

  const before = renderValue(field, event.before, ctx);
  const after = renderValue(field, event.after, ctx);

  if (field === "status" && before && after) {
    return `moved this from ${before} to ${after}`;
  }
  if (before && after) return `changed the ${label} from ${before} to ${after}`;
  if (after) return `set the ${label} to ${after}`;
  if (before) return `cleared the ${label} (was ${before})`;
  return `changed the ${label}`;
}

/** Ledger rows as the history panel renders them, newest first as stored. */
export function historyEntries(
  events: ItemEvent[],
  ctx: HistoryContext,
): HistoryEntry[] {
  return events.map((e) => {
    const { actor, automated } = describeActor(e);
    return {
      id: e.id,
      actor,
      action: describeChange(e, ctx),
      createdAt: e.createdAt,
      automated,
    };
  });
}
