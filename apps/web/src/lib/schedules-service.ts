import { features, and, eq, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import {
  describeCadence,
  isValidTimeZone,
  nextOccurrence,
  parseCadence,
  CadenceError,
  type Cadence,
} from "@/lib/schedules/cadence";
import {
  deleteSchedule,
  insertSchedule,
  listSchedules,
  patchSchedule,
  type ScheduleRow,
} from "@/lib/schedules/store";
import { findEnabledSkill } from "@/lib/skills-service";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * Creating, editing and removing schedules.
 *
 * Everything a person does to a schedule comes through here, so the two rules
 * that cannot be expressed as constraints live in one place: the skill has to
 * exist and be runnable against the thing it is pointed at, and `nextRunAt` has
 * to be derived rather than supplied. A caller that could set its own next-run
 * time could make a schedule fire immediately and repeatedly, which is a way to
 * spend the workspace's whole model budget from one request.
 */

export class ScheduleInputError extends Error {}

/**
 * What a schedule looks like to a screen or an API caller.
 *
 * Not exported yet: the routes serialise it and nothing else names the type.
 * The settings UI is the first caller that will want it by name.
 */
interface ScheduleView {
  id: string;
  name: string;
  skillKey: string;
  targetSpecId: string;
  cadence: Cadence;
  timeZone: string;
  /** The cadence as a sentence, resolved once so every surface agrees. */
  cadenceLabel: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

function view(row: ScheduleRow, targetSpecId: string): ScheduleView {
  return {
    id: row.id,
    name: row.name,
    skillKey: row.skillKey,
    targetSpecId,
    cadence: row.cadence,
    timeZone: row.timeZone,
    cadenceLabel: describeCadence(row.cadence, row.timeZone),
    enabled: row.enabled,
    // ISO, because Dates are not serializable across the server/client
    // boundary. Same treatment the API keys list gets.
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunId: row.lastRunId,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  };
}

/** The item a schedule points at, resolved through the caller's own access. */
async function resolveTarget(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<{ id: string; productId: string | null; specId: string }> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({
        id: features.id,
        productId: features.productId,
        specId: features.specId,
      })
      .from(features)
      .where(
        and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  // Read over the RLS connection, so an item the caller cannot see is
  // indistinguishable from one that does not exist. Scheduling against an item
  // you cannot open would otherwise be a way to find out it exists.
  if (!row) throw new ScheduleInputError(`Unknown item: ${specId}`);
  return row;
}

/** Everything the two write paths check about a submitted schedule. */
async function validate(
  db: Database,
  scope: WorkspaceScope,
  input: { name?: unknown; skillKey?: unknown; timeZone?: unknown; cadence?: unknown },
): Promise<{ name: string; skillKey: string; timeZone: string; cadence: Cadence }> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) {
    throw new ScheduleInputError("A schedule needs a name of 1 to 120 characters.");
  }

  const skillKey = typeof input.skillKey === "string" ? input.skillKey : "";
  const skill = skillKey ? await findEnabledSkill(db, scope, skillKey) : null;
  if (!skill) {
    throw new ScheduleInputError(
      `No skill named "${skillKey}" is available in this workspace.`,
    );
  }
  if (skill.surface !== "item") {
    // Checked here as well as at firing time. Refusing at firing time alone
    // would let somebody save a schedule that can never work and only find out
    // a week later, through a failure notification.
    throw new ScheduleInputError(
      `"${skill.name}" is a ${skill.surface} skill and cannot be scheduled against an item.`,
    );
  }

  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "";
  if (!isValidTimeZone(timeZone)) {
    throw new ScheduleInputError(`Unknown time zone: ${timeZone || "(none)"}`);
  }

  let cadence: Cadence;
  try {
    cadence = parseCadence(input.cadence);
  } catch (err) {
    throw new ScheduleInputError(
      err instanceof CadenceError ? err.message : "That cadence is not valid.",
    );
  }

  return { name, skillKey, timeZone, cadence };
}

export async function createSchedule(
  db: Database,
  scope: WorkspaceScope,
  input: {
    name?: unknown;
    skillKey?: unknown;
    specId?: unknown;
    cadence?: unknown;
    timeZone?: unknown;
    enabled?: unknown;
  },
): Promise<ScheduleView> {
  const specId = typeof input.specId === "string" ? input.specId : "";
  const target = await resolveTarget(db, scope, specId);
  const { name, skillKey, timeZone, cadence } = await validate(db, scope, input);

  const row = await insertSchedule(db, scope, {
    workspaceId: scope.workspaceId,
    productId: target.productId,
    name,
    skillKey,
    targetId: target.id,
    cadence,
    timeZone,
    enabled: input.enabled !== false,
    // Derived, never taken from the caller. See the module note: a
    // caller-supplied next-run time is a way to spend the whole model budget.
    nextRunAt: nextOccurrence(cadence, timeZone, new Date()),
    createdBy: scope.userId,
  });
  return view(row, target.specId);
}

export async function updateSchedule(
  db: Database,
  scope: WorkspaceScope,
  id: string,
  input: {
    name?: unknown;
    skillKey?: unknown;
    cadence?: unknown;
    timeZone?: unknown;
    enabled?: unknown;
  },
): Promise<ScheduleView | null> {
  const existing = await oneWithTarget(db, scope, id);
  if (!existing) return null;

  const { name, skillKey, timeZone, cadence } = await validate(db, scope, {
    name: input.name ?? existing.row.name,
    skillKey: input.skillKey ?? existing.row.skillKey,
    cadence: input.cadence ?? existing.row.cadence,
    timeZone: input.timeZone ?? existing.row.timeZone,
  });

  const row = await patchSchedule(db, scope, id, {
    name,
    skillKey,
    cadence,
    timeZone,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled === true }),
    nextRunAt: nextOccurrence(cadence, timeZone, new Date()),
    // An edited schedule starts clean. The old failures describe a schedule
    // that no longer exists in this shape, and carrying them forward would
    // switch off a freshly-corrected schedule on its next stumble.
    consecutiveFailures: 0,
    lastError: null,
  });
  return row ? view(row, existing.specId) : null;
}

export async function removeSchedule(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<boolean> {
  return deleteSchedule(db, scope, id);
}

export async function listScheduleViews(
  db: Database,
  scope: WorkspaceScope,
): Promise<ScheduleView[]> {
  const rows = await listSchedules(db, scope);
  if (rows.length === 0) return [];
  const specIds = await specIdsFor(db, scope, rows);
  return rows.flatMap((r) => {
    const specId = specIds.get(r.targetId);
    // A schedule whose item has been deleted is listed with no target rather
    // than hidden: it still exists, it still needs removing, and hiding it
    // would leave an invisible row failing every week.
    return [view(r, specId ?? "")];
  });
}

async function oneWithTarget(
  db: Database,
  scope: WorkspaceScope,
  id: string,
): Promise<{ row: ScheduleRow; specId: string } | null> {
  const rows = await listSchedules(db, scope);
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const specIds = await specIdsFor(db, scope, [row]);
  return { row, specId: specIds.get(row.targetId) ?? "" };
}

/** Internal ids to stable spec ids, in one query rather than one per row. */
async function specIdsFor(
  db: Database,
  scope: WorkspaceScope,
  rows: readonly ScheduleRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.targetId))];
  if (ids.length === 0) return new Map();
  const found = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ id: features.id, specId: features.specId })
      .from(features)
      .where(eq(features.workspaceId, scope.workspaceId)),
  );
  return new Map(
    found.filter((f) => ids.includes(f.id)).map((f) => [f.id, f.specId]),
  );
}
