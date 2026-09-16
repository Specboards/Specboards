import { features, and, eq, outboxEvents, type Database } from "@specboards/db";

import { getAppDb, getWorkerDb } from "@/lib/db";
import { runSkillOnItem } from "@/lib/runs/skill-run";

import { describeCadence, nextOccurrence } from "./cadence";
import { claimDueSchedules, recordFiring, type ScheduleRow } from "./store";

/**
 * In-process schedule dispatcher.
 *
 * The same shape as the webhook drainer next door, deliberately: a
 * `setInterval` started once at boot, a claim that leases the rows it takes,
 * and a guard so overlapping ticks never run concurrently. One machine today,
 * and `FOR UPDATE SKIP LOCKED` in the claim keeps it correct if that changes.
 *
 * ── Why the sweep is a minute and not a second ─────────────────────────────
 * The finest cadence anybody can express is a minute, so a schedule can be at
 * most a minute late. That is the right trade for a weekly digest, and a
 * tighter loop would spend a query every second for the rest of time to make
 * "09:00" mean 09:00:00 rather than 09:00:40 on a feature where nobody can
 * tell the difference.
 *
 * ── Why a firing runs as a person ──────────────────────────────────────────
 * The claim happens on the worker connection, which bypasses row-level
 * security because a sweep has no session. The run it starts does NOT: it goes
 * through the ordinary application connection as the schedule's owner, under
 * their policies and against their budget. So the dispatcher can decide that
 * something is due and can write down what came of it, and it cannot read or
 * change anything the schedule points at. A schedule whose owner has left the
 * workspace therefore fails rather than quietly running with more access than
 * that person had, which is the direction this should fail in.
 *
 * ── Failing loudly ─────────────────────────────────────────────────────────
 * The market lesson on this card is ChatGPT's scheduled tasks, which stopped
 * working silently when the surface they hung off went away. A schedule that
 * stops must say so. Every failure is counted, written to the row where the
 * settings page shows it, and announced as an event that reaches the owner's
 * inbox. After enough consecutive failures the schedule is switched off, and
 * being switched off is itself announced: a schedule that retries forever
 * against a deleted item is noise, and one that stops without saying so is the
 * thing being avoided.
 */

const INTERVAL_MS = 60_000;
const CLAIM_LIMIT = 10;
/**
 * Visibility timeout. Generous because a firing is a model call: a run that
 * takes ninety seconds is ordinary, and a lease shorter than the work would
 * let a second sweep pick up a schedule that is still running.
 */
const LEASE_SECONDS = 600;
/**
 * Consecutive failures before a schedule is switched off.
 *
 * Three, not one: a single failure is usually the endpoint having a bad
 * minute, and disabling on the first would make a transient outage look like a
 * deleted schedule. Three consecutive failures of a weekly schedule is three
 * weeks, which is long enough to be sure and short enough that the owner has
 * not yet forgotten they set it up.
 */
const GIVE_UP_AFTER = 3;

let interval: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/** Start the periodic sweep once per process. No-op in local file mode. */
export function startScheduleDispatcher(): void {
  if (interval) return;
  if (!getWorkerDb()) return;
  interval = setInterval(() => void sweepOnce(), INTERVAL_MS);
  // Shortly after boot, so schedules missed during a restart fire promptly
  // rather than waiting a full interval.
  setTimeout(() => void sweepOnce(), 5_000);
}

/**
 * One sweep. Exported for the integration test, which drives it directly
 * rather than waiting a minute for the interval.
 */
export async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  const worker = getWorkerDb();
  if (!worker) return;

  sweeping = true;
  try {
    const due = await claimDueSchedules(worker, CLAIM_LIMIT, LEASE_SECONDS);
    // Sequentially rather than in parallel. Each firing is a model call
    // against the same workspace's budget and the same provider's rate limit,
    // and ten at once is how a sweep turns into a burst of 429s.
    for (const schedule of due) {
      await fireOne(worker, schedule);
    }
  } catch (err) {
    console.error("[schedules] sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

async function fireOne(worker: Database, schedule: ScheduleRow): Promise<void> {
  const appDb = getAppDb();
  let runId: string | null = null;
  let error: string | null = null;

  try {
    if (!appDb) throw new Error("No tenant database connection.");

    // The claim ran as the worker, so the target has not been checked against
    // anybody's access yet. Resolving the spec id here on the worker
    // connection is a read of a routing value, not a grant: the run opened
    // below re-reads the item as the schedule's owner, and refuses if they
    // cannot see it.
    const specId = await specIdFor(worker, schedule);
    if (!specId) {
      throw new Error(
        "The item this schedule points at no longer exists.",
      );
    }

    const outcome = await runSkillOnItem(
      appDb,
      { userId: schedule.createdBy, workspaceId: schedule.workspaceId },
      {
        specId,
        skillKey: schedule.skillKey,
        // No agent identity: a schedule is a standing instruction from the
        // person who set it up, not a separate actor. `agent_runs_one_active_uq`
        // keys on this, so two schedules on the same item and skill collapse
        // to one active run rather than racing.
        agentId: null,
        trigger: "schedule",
      },
    );
    runId = outcome.runId;
    // A run that finished `failed` is a failed firing. The run already carries
    // the readable reason, and repeating it on the schedule is what makes the
    // settings list able to say why without loading every run.
    if (outcome.status === "failed") error = outcome.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const failures = error === null ? 0 : schedule.consecutiveFailures + 1;
  const giveUp = failures >= GIVE_UP_AFTER;

  await recordFiring(worker, schedule.id, {
    // Computed from the cadence and from now, not from the leased `nextRunAt`,
    // which the claim already moved. Asking for the next occurrence after the
    // present is also what stops a schedule that was down for a week from
    // firing seven times to catch up: it resumes, it does not backfill.
    nextRunAt: nextOccurrence(schedule.cadence, schedule.timeZone, new Date()),
    runId,
    error,
    consecutiveFailures: failures,
    ...(giveUp ? { enabled: false } : {}),
  });

  if (error !== null) {
    await announceFailure(worker, schedule, error, giveUp);
  }
}

/** The item's stable spec id, which is what the run path addresses it by. */
async function specIdFor(
  db: Database,
  schedule: ScheduleRow,
): Promise<string | null> {
  const [row] = await db
    .select({ specId: features.specId })
    .from(features)
    .where(
      and(
        eq(features.id, schedule.targetId),
        eq(features.workspaceId, schedule.workspaceId),
      ),
    )
    .limit(1);
  return row?.specId ?? null;
}

/**
 * Say that a schedule failed, to the person who set it up.
 *
 * Through the outbox rather than by writing a notification directly, so it
 * travels the same road as every other notice and reaches webhook subscribers
 * too. An integration watching agent work wants to know a schedule has stopped
 * at least as much as a person does.
 *
 * `actorId` is null on purpose, and it is the detail that makes this work at
 * all. The fan-out subtracts the actor before anything else, because nobody is
 * told about their own action. The owner of a schedule is exactly the person
 * who must hear that it failed, so naming them as the actor would silently
 * deliver this to nobody. No person did this; a sweep did.
 */
async function announceFailure(
  db: Database,
  schedule: ScheduleRow,
  reason: string,
  disabled: boolean,
): Promise<void> {
  try {
    await db.insert(outboxEvents).values({
      workspaceId: schedule.workspaceId,
      productId: schedule.productId,
      actorId: null,
      type: "schedule.failed",
      data: {
        scheduleId: schedule.id,
        name: schedule.name,
        skillKey: schedule.skillKey,
        targetType: schedule.targetType,
        targetId: schedule.targetId,
        ownerId: schedule.createdBy,
        cadence: describeCadence(schedule.cadence, schedule.timeZone),
        reason,
        disabled,
      },
    });
  } catch (err) {
    // Swallowed for the same reason the fan-out swallows its own: the failure
    // is already recorded on the schedule row, and losing the announcement is
    // better than throwing out of a sweep and stranding the schedules behind
    // this one.
    console.error(
      `[schedules] could not announce failure of ${schedule.id}:`,
      err,
    );
  }
}
