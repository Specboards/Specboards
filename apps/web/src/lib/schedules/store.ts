import { agentSchedules, and, asc, eq, sql, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import type { WorkspaceScope } from "@/lib/store/types";

import { parseCadence, type Cadence } from "./cadence";

/**
 * Reading and writing schedule rows.
 *
 * Two connections use this file and they are not interchangeable. Everything a
 * person does goes through `asUser` on the application connection, so the
 * owner-only write policies in migration 0019 decide it. The dispatcher's claim
 * and outcome-recording run on the worker connection, which bypasses those
 * policies by design: a sweep has no session and cannot be a member of every
 * workspace it wakes for. Those two functions are named for it and take a plain
 * `Database` rather than a scope, so the difference is visible at every call
 * site rather than buried in a parameter.
 */

export interface ScheduleRow {
  id: string;
  workspaceId: string;
  productId: string | null;
  name: string;
  skillKey: string;
  targetType: "feature";
  targetId: string;
  cadence: Cadence;
  timeZone: string;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastRunId: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = {
  id: agentSchedules.id,
  workspaceId: agentSchedules.workspaceId,
  productId: agentSchedules.productId,
  name: agentSchedules.name,
  skillKey: agentSchedules.skillKey,
  targetType: agentSchedules.targetType,
  targetId: agentSchedules.targetId,
  cadence: agentSchedules.cadence,
  timeZone: agentSchedules.timeZone,
  enabled: agentSchedules.enabled,
  nextRunAt: agentSchedules.nextRunAt,
  lastRunAt: agentSchedules.lastRunAt,
  lastRunId: agentSchedules.lastRunId,
  lastError: agentSchedules.lastError,
  consecutiveFailures: agentSchedules.consecutiveFailures,
  createdBy: agentSchedules.createdBy,
  createdAt: agentSchedules.createdAt,
  updatedAt: agentSchedules.updatedAt,
};

/** Narrow the columns the database has already CHECKed, and parse the cadence. */
function toRow(r: Record<string, unknown>): ScheduleRow {
  return {
    ...(r as unknown as ScheduleRow),
    targetType: "feature",
    // Parsed rather than cast. A stored cadence that no longer parses is a row
    // the dispatcher must refuse loudly rather than fire on a guess.
    cadence: parseCadence(r.cadence),
  };
}

interface CreateScheduleInput {
  workspaceId: string;
  productId: string | null;
  name: string;
  skillKey: string;
  targetId: string;
  cadence: Cadence;
  timeZone: string;
  enabled: boolean;
  nextRunAt: Date;
  createdBy: string;
}

export async function insertSchedule(
  db: Database,
  scope: WorkspaceScope,
  input: CreateScheduleInput,
): Promise<ScheduleRow> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .insert(agentSchedules)
      .values({ ...input, targetType: "feature" })
      .returning(COLUMNS),
  );
  if (!row) {
    // The insert policy is owner-only, and a refused insert returns no row
    // rather than raising. Saying so is better than returning undefined and
    // letting the caller report a mystery.
    throw new Error("Creating the schedule was refused.");
  }
  return toRow(row);
}

export async function listSchedules(
  db: Database,
  scope: WorkspaceScope,
): Promise<ScheduleRow[]> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .select(COLUMNS)
      .from(agentSchedules)
      .where(eq(agentSchedules.workspaceId, scope.workspaceId))
      .orderBy(asc(agentSchedules.createdAt)),
  );
  return rows.map(toRow);
}

interface SchedulePatch {
  name?: string;
  skillKey?: string;
  cadence?: Cadence;
  timeZone?: string;
  enabled?: boolean;
  nextRunAt?: Date;
  /** Cleared when a schedule is edited: past failures describe the old one. */
  consecutiveFailures?: number;
  lastError?: string | null;
}

export async function patchSchedule(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  patch: SchedulePatch,
): Promise<ScheduleRow | null> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .update(agentSchedules)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(agentSchedules.id, id),
          eq(agentSchedules.workspaceId, scope.workspaceId),
        ),
      )
      .returning(COLUMNS),
  );
  return row ? toRow(row) : null;
}

export async function deleteSchedule(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<boolean> {
  const rows = await asUser(db, scope.userId, (tx) =>
    tx
      .delete(agentSchedules)
      .where(
        and(
          eq(agentSchedules.id, id),
          eq(agentSchedules.workspaceId, scope.workspaceId),
        ),
      )
      .returning({ id: agentSchedules.id }),
  );
  return rows.length > 0;
}

// ============================================================================
// The dispatcher's half: worker connection, no scope
// ============================================================================

/**
 * Claim the schedules that are due, pushing each one's clock forward by the
 * lease as it is taken.
 *
 * `FOR UPDATE SKIP LOCKED` and a lease, exactly as `claimDueDeliveries` does,
 * and for the same two reasons. A second dispatcher on another machine takes
 * different rows rather than the same ones, and a firing that crashes leaves a
 * row that becomes due again after the lease rather than one that is lost or
 * one that is retried instantly forever.
 *
 * The lease is written into `next_run_at` rather than into a separate column
 * because the two mean the same thing to every reader: the earliest moment
 * this schedule may be picked up again. A settings page showing "next run" at
 * a leased time during the few seconds a firing takes is showing the truth.
 */
export async function claimDueSchedules(
  db: Database,
  limit: number,
  leaseSeconds: number,
): Promise<ScheduleRow[]> {
  const result = await db.execute(sql`
    WITH due AS (
      SELECT id FROM agent_schedules
      WHERE enabled AND next_run_at <= now()
      ORDER BY next_run_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE agent_schedules s
    SET next_run_at = now() + (${leaseSeconds} * interval '1 second')
    FROM due
    WHERE s.id = due.id
    RETURNING s.id, s.workspace_id, s.product_id, s.name, s.skill_key,
              s.target_type, s.target_id, s.cadence, s.time_zone, s.enabled,
              s.next_run_at, s.last_run_at, s.last_run_id, s.last_error,
              s.consecutive_failures, s.created_by, s.created_at, s.updated_at
  `);
  const rows = result as unknown as Record<string, unknown>[];
  return rows.map((r) =>
    toRow({
      id: r.id,
      workspaceId: r.workspace_id,
      productId: r.product_id,
      name: r.name,
      skillKey: r.skill_key,
      targetType: r.target_type,
      targetId: r.target_id,
      cadence: r.cadence,
      timeZone: r.time_zone,
      enabled: r.enabled,
      nextRunAt: r.next_run_at,
      lastRunAt: r.last_run_at,
      lastRunId: r.last_run_id,
      lastError: r.last_error,
      consecutiveFailures: Number(r.consecutive_failures),
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }),
  );
}

/** What a firing produced, written back on the worker connection. */
interface FiringOutcome {
  nextRunAt: Date;
  runId: string | null;
  error: string | null;
  /** Reset to 0 on success; incremented on failure by the dispatcher. */
  consecutiveFailures: number;
  /** Set false when the dispatcher gives up on a schedule for good. */
  enabled?: boolean;
}

export async function recordFiring(
  db: Database,
  id: string,
  outcome: FiringOutcome,
): Promise<void> {
  await db
    .update(agentSchedules)
    .set({
      nextRunAt: outcome.nextRunAt,
      lastRunAt: new Date(),
      lastRunId: outcome.runId,
      lastError: outcome.error,
      consecutiveFailures: outcome.consecutiveFailures,
      ...(outcome.enabled === undefined ? {} : { enabled: outcome.enabled }),
      updatedAt: new Date(),
    })
    .where(eq(agentSchedules.id, id));
}
