import {
  and,
  desc,
  eq,
  gte,
  modelUsageEvents,
  sql,
  users,
  workspaceUsageLimits,
  type Database,
} from "@specboards/db";

import { asUser, type ScopedTx } from "@/lib/db-scope";

/**
 * What the workspace has spent at its own model provider, and what it is
 * allowed to spend.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The customer brings the endpoint and the key, so every token is billed to
 * them by a vendor we have no relationship with. That is the arrangement they
 * agreed to and it still goes badly for us if the first they hear of it is an
 * unattributable line on an invoice. Two jobs, and they are the same job from
 * opposite ends: record every call so the bill can be explained afterwards, and
 * refuse a call that would take the workspace past a cap it set beforehand.
 *
 * ── Where it is wired in ────────────────────────────────────────────────────
 * Nowhere except `model-provider-service.ts`, which is the single choke point
 * every call to a model goes through. That is deliberate: accounting that each
 * caller opts into is accounting that the next caller forgets, and the missing
 * rows are invisible precisely because they are missing. The attribution is a
 * required argument on both entry points there, so adding a call site that
 * spends money without saying whose money it is does not compile.
 *
 * ── Periods are UTC ─────────────────────────────────────────────────────────
 * "This month" and "today" are calendar boundaries in UTC, not in the reader's
 * timezone. A workspace is not in one timezone, and a cap whose reset moment
 * depends on who is asking is a cap nobody can reason about. The UI says which
 * it means rather than leaving it to be discovered.
 */

/**
 * What triggered a call, as the ledger records it.
 *
 * A closed set in code rather than a CHECK in the database (see migration
 * 0074): adding a call site should not need a migration, because the friction
 * of one is how a new feature ends up filed under an existing label.
 */
export type UsageFeature =
  | "assistant_turn"
  | "breakdown"
  | "release_notes_draft"
  | "connection_test";

/** Human wording for the usage screen. Unknown keys fall back to the key. */
const FEATURE_LABELS: Record<string, string> = {
  assistant_turn: "Assistant questions",
  breakdown: "Breakdown proposals",
  release_notes_draft: "Release notes drafts",
  connection_test: "Connection tests",
};

export function usageFeatureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

/**
 * Whose spend this is. Carried through every inference call rather than
 * resolved here, because by the time this module sees a call the acting user is
 * long out of scope, and "the workspace spent it" is not an answer anyone can
 * act on.
 */
export interface UsageAttribution {
  userId: string;
  feature: UsageFeature;
}

/** One recorded call. `null` tokens mean the endpoint reported nothing. */
export interface UsageRecord extends UsageAttribution {
  workspaceId: string;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  outcome: "ok" | "error" | "cancelled";
  errorKind?: string | null;
}

/**
 * Write one call to the ledger. Never throws.
 *
 * Best effort on purpose. This runs after an answer has already been streamed
 * to somebody, and there is nothing useful left to do with a failure at that
 * point: turning a delivered answer into an error because the bookkeeping write
 * lost a race would be a worse outcome than an under-reported total, which the
 * usage screen already has to describe honestly because endpoints omit usage
 * anyway.
 */
export async function recordUsage(
  db: Database,
  record: UsageRecord,
): Promise<void> {
  try {
    // `record.userId` is both the person the spend is attributed to and the
    // person whose membership the append policy checks. They are the same
    // person by construction: a call is recorded against whoever made it.
    await asUser(db, record.userId, (tx) =>
      tx.insert(modelUsageEvents).values({
      workspaceId: record.workspaceId,
      userId: record.userId,
      feature: record.feature,
      model: record.model,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      outcome: record.outcome,
      errorKind: record.errorKind ?? null,
      }),
    );
  } catch {
    // Deliberately swallowed; see the note above.
  }
}

/**
 * Who is asking, and about which workspace. Required because these run on the
 * RLS-enforced connection, where 0074's policies need an acting member: reads
 * are member-level, the ledger is member-append, and the caps are org-admin
 * write.
 */
export interface UsageScope {
  userId: string;
  workspaceId: string;
}

/** A workspace's caps. Null means uncapped, which is not zero. */
export interface UsageLimits {
  monthlyTokenCap: number | null;
  dailyUserTokenCap: number | null;
  updatedAt: string | null;
}

/** No row means nobody has ever set a cap, which is uncapped. */
export const NO_LIMITS: UsageLimits = {
  monthlyTokenCap: null,
  dailyUserTokenCap: null,
  updatedAt: null,
};

export async function getUsageLimits(
  db: Database,
  scope: UsageScope,
): Promise<UsageLimits> {
  return asUser(db, scope.userId, (tx) => readLimits(tx, scope.workspaceId));
}

/** The caps, on a transaction the caller already has open. */
async function readLimits(tx: ScopedTx, workspaceId: string): Promise<UsageLimits> {
  const [row] = await tx
    .select()
    .from(workspaceUsageLimits)
    .where(eq(workspaceUsageLimits.workspaceId, workspaceId))
    .limit(1);
  if (!row) return NO_LIMITS;
  return {
    monthlyTokenCap: row.monthlyTokenCap,
    dailyUserTokenCap: row.dailyUserTokenCap,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A cap that is not a non-negative whole number, or is absurdly large. */
export class UsageLimitInputError extends Error {}

/**
 * Largest cap accepted. Not a technical limit: it is the point past which a
 * number has stopped being a guardrail and is almost certainly a typo, and a
 * typo here is the difference between a cap and no cap at all.
 */
export const MAX_TOKEN_CAP = 1_000_000_000;

function parseCap(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new UsageLimitInputError(`${field} must be a whole number of tokens, or blank for no cap.`);
  }
  if (n > MAX_TOKEN_CAP) {
    throw new UsageLimitInputError(
      `${field} must be at most ${MAX_TOKEN_CAP.toLocaleString()} tokens.`,
    );
  }
  return n;
}

export interface UsageLimitsInput {
  /** Blank, null or omitted all mean "no cap". */
  monthlyTokenCap?: number | string | null;
  dailyUserTokenCap?: number | string | null;
}

/**
 * Set the caps. Upsert, because a settings form that saves should not have to
 * know whether it is the first save.
 */
export async function saveUsageLimits(
  db: Database,
  scope: UsageScope,
  input: UsageLimitsInput,
): Promise<UsageLimits> {
  const monthlyTokenCap = parseCap(input.monthlyTokenCap, "The monthly cap");
  const dailyUserTokenCap = parseCap(input.dailyUserTokenCap, "The per-person daily cap");
  const { workspaceId, userId } = scope;

  const [row] = await asUser(db, userId, (tx) =>
    tx
      .insert(workspaceUsageLimits)
      .values({
      workspaceId,
      monthlyTokenCap,
      dailyUserTokenCap,
      updatedBy: userId,
    })
      .onConflictDoUpdate({
        target: workspaceUsageLimits.workspaceId,
        set: {
          monthlyTokenCap,
          dailyUserTokenCap,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      })
      .returning(),
  );

  return {
    monthlyTokenCap: row!.monthlyTokenCap,
    dailyUserTokenCap: row!.dailyUserTokenCap,
    updatedAt: row!.updatedAt.toISOString(),
  };
}

/** Start of the current calendar month, UTC. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the current day, UTC. */
export function dayStart(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Tokens counted as spent. `NULL` columns contribute nothing, which is the only
 * honest choice: an endpoint that reports no usage has not told us the call was
 * free, and inventing a figure for it would put a number we made up into a
 * total the customer may hold us to. The usage screen says how many calls went
 * unmeasured so the gap is visible rather than absorbed.
 */
const SPENT = sql<number>`coalesce(sum(coalesce(${modelUsageEvents.promptTokens}, 0) + coalesce(${modelUsageEvents.completionTokens}, 0)), 0)::bigint`;

async function tokensSince(
  db: Database,
  scope: UsageScope,
  since: Date,
  forUserId?: string,
): Promise<number> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ total: SPENT })
      .from(modelUsageEvents)
      .where(
        and(
          eq(modelUsageEvents.workspaceId, scope.workspaceId),
          gte(modelUsageEvents.createdAt, since),
          ...(forUserId ? [eq(modelUsageEvents.userId, forUserId)] : []),
        ),
      ),
  );
  return Number(row?.total ?? 0);
}

/** Allowed, or refused with something a person can act on. */
export type AllowanceDecision =
  | { allowed: true }
  | { allowed: false; scope: "workspace" | "user"; message: string };

/**
 * Whether this call may go ahead.
 *
 * ── Why the estimate is part of the comparison ──────────────────────────────
 * The naive check is "have we already passed the cap", which lets the single
 * call that crosses it through however large that call is. That is the wrong
 * failure for a guardrail whose whole purpose is the runaway case: one
 * breakdown over a big tree can be most of a month's budget on its own. So the
 * estimate is added first and the call is refused if the *result* would exceed
 * the cap, which means a cap behaves like a ceiling rather than a tripwire.
 *
 * The cost is that an estimate that runs high can refuse a call that would have
 * fitted. That is the direction to be wrong in: the person is told the number
 * and who can raise it, and nothing was spent.
 *
 * ── Why this is not a transaction ───────────────────────────────────────────
 * Two calls racing can both pass a check that neither would pass afterwards.
 * Serializing them would mean a lock held across a request to a third party for
 * as long as that party takes to answer, which is a far worse property than a
 * cap that can be overshot by roughly one call's worth of tokens under
 * concurrency. The cap is a spend guardrail, not a payment authorization.
 */
export async function checkUsageAllowance(
  db: Database,
  workspaceId: string,
  attribution: UsageAttribution,
  estimatedTokens: number,
  now: Date = new Date(),
): Promise<AllowanceDecision> {
  // The cap check runs inside an ordinary member's request, before their
  // question is sent, which is exactly why 0074 made both tables member-read
  // rather than owner-only. The acting user is the one being attributed.
  const asking = { userId: attribution.userId, workspaceId };
  const limits = await getUsageLimits(db, asking);
  if (limits.monthlyTokenCap === null && limits.dailyUserTokenCap === null) {
    return { allowed: true };
  }

  const estimate = Math.max(0, Math.ceil(estimatedTokens));

  if (limits.monthlyTokenCap !== null) {
    const used = await tokensSince(db, asking, monthStart(now));
    if (used + estimate > limits.monthlyTokenCap) {
      return {
        allowed: false,
        scope: "workspace",
        message: `This workspace has used ${used.toLocaleString()} of its ${limits.monthlyTokenCap.toLocaleString()} token budget for this month. An admin can raise the cap in Settings under Integrations.`,
      };
    }
  }

  if (limits.dailyUserTokenCap !== null) {
    const used = await tokensSince(db, asking, dayStart(now), attribution.userId);
    if (used + estimate > limits.dailyUserTokenCap) {
      return {
        allowed: false,
        scope: "user",
        message: `You have used ${used.toLocaleString()} of your ${limits.dailyUserTokenCap.toLocaleString()} token allowance for today (UTC). It resets at midnight UTC, or an admin can raise it in Settings under Integrations.`,
      };
    }
  }

  return { allowed: true };
}

/** One line of the usage screen. */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  tokens: number;
  calls: number;
}

export interface UsageSummary {
  /** ISO instant the period started (UTC month boundary). */
  periodStart: string;
  /** Prompt + completion tokens recorded this period. */
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /**
   * Calls whose endpoint reported no usage at all. Surfaced rather than hidden:
   * without it a workspace on a runtime that omits usage sees a total of zero
   * and concludes the accounting is broken, which is nearly the right
   * conclusion and exactly the wrong action.
   */
  unmeasuredCalls: number;
  failedCalls: number;
  byFeature: UsageBreakdownRow[];
  byUser: UsageBreakdownRow[];
  limits: UsageLimits;
}

/**
 * This period's spend, by feature and by person.
 *
 * The per-person breakdown is management information, so the route that serves
 * this is org-admin only. It is not gated here: this module is also what the
 * cap check calls, and a service that decides authorization for one caller and
 * not the other is a service whose rules cannot be read off it.
 */
export async function summarizeUsage(
  db: Database,
  scope: UsageScope,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const since = monthStart(now);
  const period = and(
    eq(modelUsageEvents.workspaceId, scope.workspaceId),
    gte(modelUsageEvents.createdAt, since),
  );

  // All three aggregates in one scoped transaction: they are three views of the
  // same period and a summary assembled from two different instants could
  // report a per-person breakdown that does not add up to its own total.
  return asUser(db, scope.userId, async (tx) => {
  const [totals] = await tx
    .select({
      prompt: sql<number>`coalesce(sum(coalesce(${modelUsageEvents.promptTokens}, 0)), 0)::bigint`,
      completion: sql<number>`coalesce(sum(coalesce(${modelUsageEvents.completionTokens}, 0)), 0)::bigint`,
      calls: sql<number>`count(*)::int`,
      unmeasured: sql<number>`count(*) filter (where ${modelUsageEvents.promptTokens} is null and ${modelUsageEvents.completionTokens} is null)::int`,
      failed: sql<number>`count(*) filter (where ${modelUsageEvents.outcome} = 'error')::int`,
    })
    .from(modelUsageEvents)
    .where(period);

  const featureRows = await tx
    .select({
      key: modelUsageEvents.feature,
      tokens: SPENT,
      calls: sql<number>`count(*)::int`,
    })
    .from(modelUsageEvents)
    .where(period)
    .groupBy(modelUsageEvents.feature)
    .orderBy(desc(SPENT));

  // Left-joined, not inner: the ledger keeps a snapshot user id with no FK, so
  // a row whose person has since been removed still has to appear in the total
  // rather than silently reducing it.
  const userRows = await tx
    .select({
      key: modelUsageEvents.userId,
      name: users.name,
      tokens: SPENT,
      calls: sql<number>`count(*)::int`,
    })
    .from(modelUsageEvents)
    .leftJoin(users, eq(users.id, modelUsageEvents.userId))
    .where(period)
    .groupBy(modelUsageEvents.userId, users.name)
    .orderBy(desc(SPENT));

  const promptTokens = Number(totals?.prompt ?? 0);
  const completionTokens = Number(totals?.completion ?? 0);

  return {
    periodStart: since.toISOString(),
    tokens: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    calls: Number(totals?.calls ?? 0),
    unmeasuredCalls: Number(totals?.unmeasured ?? 0),
    failedCalls: Number(totals?.failed ?? 0),
    byFeature: featureRows.map((r) => ({
      key: r.key,
      label: usageFeatureLabel(r.key),
      tokens: Number(r.tokens),
      calls: Number(r.calls),
    })),
    byUser: userRows.map((r) => ({
      key: r.key,
      label: r.name ?? "Removed member",
      tokens: Number(r.tokens),
      calls: Number(r.calls),
    })),
    // Read inside the same transaction, so the caps reported beside the totals
    // are the caps that were in force for them.
    limits: await readLimits(tx, scope.workspaceId),
  };
  });
}
