import { specWriteAudit, type Database } from "@specboards/db";

/**
 * The product's own record of what happened to a spec.
 *
 * Deliberately not a duplicate of git history. It answers the question inside
 * the app, where the people asking it are and without needing a checkout, and
 * it stays answerable when the write did not land. Git has no record of a
 * commit that never happened, which is exactly the case someone is
 * investigating when they ask why a change they remember making is not there.
 *
 * So a refusal is recorded as carefully as a success, carrying the reason in
 * the words the author was shown. "Your role does not permit editing this spec"
 * six weeks later is an answer; a missing row is not.
 */

export type SpecWriteAction = "create" | "update" | "remove";
export type SpecWriteOutcome = "committed" | "proposed" | "refused" | "failed";

/**
 * How the change was credited.
 *
 * The distinction is what makes this worth keeping once user tokens exist. A
 * repository full of app-authored commits looks identical whether attribution
 * is working or has quietly stopped, and this column is the difference.
 */
export type SpecWriteAttribution = "author" | "co_author" | "none";

export interface SpecWriteRecord {
  workspaceId: string;
  actorId?: string | null;
  actorLabel?: string | null;
  specId?: string | null;
  repoId?: string | null;
  path: string;
  action: SpecWriteAction;
  mode?: string | null;
  outcome: SpecWriteOutcome;
  attribution: SpecWriteAttribution;
  commitSha?: string | null;
  pullRequestNumber?: number | null;
  detail?: string | null;
}

/**
 * Append one row. Never throws.
 *
 * A failed audit write must not turn a successful save into an error the author
 * has to act on, and must not mask the original failure it was recording. It is
 * logged loudly instead, because an audit trail that is quietly not being
 * written is worse than one that is obviously broken.
 */
export async function recordSpecWrite(
  db: Database,
  record: SpecWriteRecord,
): Promise<void> {
  try {
    await db.insert(specWriteAudit).values({
      workspaceId: record.workspaceId,
      actorId: record.actorId ?? null,
      actorLabel: record.actorLabel ?? null,
      specId: record.specId ?? null,
      repoId: record.repoId ?? null,
      path: record.path,
      action: record.action,
      mode: record.mode ?? null,
      outcome: record.outcome,
      attribution: record.attribution,
      commitSha: record.commitSha ?? null,
      pullRequestNumber: record.pullRequestNumber ?? null,
      // Bounded: a stack trace or a wall of GitHub JSON in an audit row makes
      // the rows around it unreadable, which defeats the point of the table.
      detail: record.detail ? record.detail.slice(0, 500) : null,
    });
  } catch (err) {
    console.error("[spec-write-audit] could not record a spec write:", err);
  }
}
