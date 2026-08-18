import {
  eq,
  modelProviderCredentials,
  modelProviders,
  type Database,
} from "@specboards/db";

import { assertReachableModelUrl } from "@/lib/ai/egress";
import { estimatePromptTokens } from "@/lib/ai/estimate";
import { createOpenAiCompatibleClient } from "@/lib/ai/openai-compatible";
import type {
  CompletionOutcome,
  ModelListOutcome,
  ProviderConfig,
  StreamEvent,
  StreamRequest,
} from "@/lib/ai/provider";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  checkUsageAllowance,
  recordUsage,
  type UsageAttribution,
} from "@/lib/usage-service";

/**
 * The workspace's model connection: read it, write it, and call through it.
 *
 * Every function here takes a `Database` and a workspace id rather than
 * resolving them itself, matching `webhooks-service` and keeping the RLS-scoped
 * connection the caller's choice. Authorization is the route's job; the policies
 * in migration 0067 are the backstop, not the gate.
 *
 * The one rule this module enforces on everyone's behalf: a decrypted
 * credential never leaves it except into an adapter. {@link ModelProviderView}
 * is the only shape any caller gets, and it carries a hint, never a secret.
 */

/** A bad request body (unusable URL, empty model, etc.). Routes map to 422. */
export class ModelProviderInputError extends Error {}

/** Safe-to-serialize view. Deliberately has no field that could hold a key. */
export interface ModelProviderView {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** Last few characters of the key, or null when the endpoint takes none. */
  credentialHint: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderInput {
  baseUrl: string;
  model: string;
  /** Omit to keep the stored key; null to remove it; a string to replace it. */
  apiKey?: string | null;
}

/** Last 4 characters, which is enough to recognise a key without exposing it. */
function hintFor(apiKey: string): string {
  return apiKey.slice(-4);
}

function toView(
  row: typeof modelProviders.$inferSelect,
  hint: string | null,
): ModelProviderView {
  return {
    id: row.id,
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    credentialHint: hint,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Validate what a caller supplied. The URL check is the egress policy, so a
 * hosted deployment refuses a private address here rather than at call time,
 * which is where a user can still do something about it.
 */
async function validate(input: ModelProviderInput): Promise<{
  baseUrl: string;
  model: string;
}> {
  const baseUrl = input.baseUrl?.trim() ?? "";
  const model = input.model?.trim() ?? "";
  if (!baseUrl) throw new ModelProviderInputError("A base URL is required.");
  if (!model) throw new ModelProviderInputError("A model name is required.");

  const check = await assertReachableModelUrl(baseUrl);
  if (!check.ok) throw new ModelProviderInputError(check.reason);
  return { baseUrl, model };
}

/** The workspace's connection, or null when none is configured. */
export async function getModelProvider(
  db: Database,
  workspaceId: string,
): Promise<ModelProviderView | null> {
  const [row] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.workspaceId, workspaceId))
    .limit(1);
  if (!row) return null;
  return toView(row, await hintFor_(db, row.credentialId));
}

/** Read just the hint for a credential id, never the secret. */
async function hintFor_(db: Database, credentialId: string | null) {
  if (!credentialId) return null;
  const [cred] = await db
    .select({ hint: modelProviderCredentials.hint })
    .from(modelProviderCredentials)
    .where(eq(modelProviderCredentials.id, credentialId))
    .limit(1);
  return cred?.hint ?? null;
}

/**
 * Create or replace the workspace's connection.
 *
 * Upsert rather than separate create/update because the unique index makes a
 * second row impossible anyway, and a settings screen that saves a form should
 * not have to know whether it is the first save.
 */
export async function saveModelProvider(
  db: Database,
  workspaceId: string,
  input: ModelProviderInput,
): Promise<ModelProviderView> {
  const { baseUrl, model } = await validate(input);

  const [existing] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.workspaceId, workspaceId))
    .limit(1);

  // Resolve the credential first, so the provider row never points at a
  // half-written one. `undefined` means "leave whatever is there".
  let credentialId = existing?.credentialId ?? null;
  if (input.apiKey !== undefined) {
    const previous = credentialId;
    if (input.apiKey === null || input.apiKey.trim() === "") {
      credentialId = null;
    } else {
      const key = input.apiKey.trim();
      const [created] = await db
        .insert(modelProviderCredentials)
        .values({ workspaceId, secret: encryptSecret(key), hint: hintFor(key) })
        .returning();
      credentialId = created!.id;
    }
    // Retire the old row only after the new one exists and the provider is
    // about to point at it. Rotation should never leave a window with no
    // usable credential.
    if (previous && previous !== credentialId) {
      await db
        .delete(modelProviderCredentials)
        .where(eq(modelProviderCredentials.id, previous));
    }
  }

  if (existing) {
    const [updated] = await db
      .update(modelProviders)
      .set({ baseUrl, model, credentialId, updatedAt: new Date() })
      .where(eq(modelProviders.id, existing.id))
      .returning();
    return toView(updated!, await hintFor_(db, credentialId));
  }

  const [created] = await db
    .insert(modelProviders)
    .values({ workspaceId, kind: "openai_compatible", baseUrl, model, credentialId })
    .returning();
  return toView(created!, await hintFor_(db, credentialId));
}

/**
 * Remove the connection and its credential.
 *
 * The credential is deleted explicitly rather than left to a cascade: the FK is
 * `ON DELETE SET NULL` (it protects the provider from a vanishing credential,
 * not the other way round), so relying on it would orphan the secret.
 */
export async function deleteModelProvider(
  db: Database,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.workspaceId, workspaceId))
    .limit(1);
  if (!row) return false;

  await db.delete(modelProviders).where(eq(modelProviders.id, row.id));
  if (row.credentialId) {
    await db
      .delete(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, row.credentialId));
  }
  return true;
}

/**
 * Resolve the workspace's connection into something callable, decrypting the
 * credential. The only function that returns plaintext, and it is not exported:
 * callers get {@link completeWithWorkspaceModel} instead, so there is no way to
 * obtain a key without making a call.
 */
async function resolveConfig(
  db: Database,
  workspaceId: string,
): Promise<{ id: string; config: ProviderConfig } | null> {
  const [row] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.workspaceId, workspaceId))
    .limit(1);
  if (!row || !row.enabled) return null;

  let apiKey: string | null = null;
  if (row.credentialId) {
    const [cred] = await db
      .select({ secret: modelProviderCredentials.secret })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, row.credentialId))
      .limit(1);
    apiKey = cred ? decryptSecret(cred.secret) : null;
  }
  return { id: row.id, config: { baseUrl: row.baseUrl, model: row.model, apiKey } };
}

/**
 * Compare two base URLs as endpoints rather than as strings, so a trailing
 * slash or a capitalised host does not read as a different server.
 */
function sameEndpoint(a: string, b: string): boolean {
  const norm = (raw: string) => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

export interface ModelListInput {
  /** Probe this endpoint instead of the stored one, so the picker works while
   * the connection form is still being filled in. Defaults to the stored URL. */
  baseUrl?: string;
  /** A key typed into the form but not saved yet. */
  apiKey?: string | null;
}

/** No connection saved and none supplied, so there is nothing to ask. */
export type WorkspaceModelListOutcome =
  | ModelListOutcome
  | { ok: false; error: { kind: "not_configured"; message: string } };

/**
 * Ask an endpoint which models it serves, so an admin picks from a list rather
 * than typing a string they have to get exactly right.
 *
 * ── Why the stored key is not always used ───────────────────────────────────
 * This accepts a base URL from the caller, which means it could be asked to
 * send the workspace's stored credential to an address the caller just typed.
 * That would make a write-only secret readable by anyone who can reach this
 * route: point it at a server you control, read the Authorization header.
 *
 * So the stored key is only ever sent to the endpoint it was stored for. Probe
 * a different URL and you get whatever key you supplied with it, or none. The
 * cost is that changing the endpoint means re-entering the key before the
 * picker can list anything, which is the correct trade.
 */
export async function listWorkspaceModels(
  db: Database,
  workspaceId: string,
  input: ModelListInput = {},
): Promise<WorkspaceModelListOutcome> {
  const [row] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.workspaceId, workspaceId))
    .limit(1);

  const baseUrl = (input.baseUrl?.trim() || row?.baseUrl || "").trim();
  if (!baseUrl) {
    return {
      ok: false,
      error: {
        kind: "not_configured",
        message: "Enter a base URL before listing the models it serves.",
      },
    };
  }

  const supplied = input.apiKey?.trim() ?? "";
  let apiKey: string | null = supplied || null;
  if (!apiKey && row?.credentialId && sameEndpoint(baseUrl, row.baseUrl)) {
    const [cred] = await db
      .select({ secret: modelProviderCredentials.secret })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, row.credentialId))
      .limit(1);
    apiKey = cred ? decryptSecret(cred.secret) : null;
  }

  // `model` is irrelevant to listing; passing the stored one keeps the config
  // shape honest rather than inventing an empty string with no meaning.
  return createOpenAiCompatibleClient({
    baseUrl,
    model: row?.model ?? "",
    apiKey,
  }).listModels();
  // `last_used_at` is deliberately not touched here: it answers "is this
  // connection actually serving the product", and a settings screen listing
  // models would make every configuration visit look like inference.
}

/**
 * What a call would cost at most, for the cap check.
 *
 * Prompt estimate plus the ceiling the caller put on generation, because the
 * cap has to hold against the worst case rather than the typical one: a
 * guardrail that admits a call on an average and is then handed a maximum is
 * not a guardrail. `maxTokens` is a fact the caller supplied, not a guess; when
 * there is none there is genuinely no bound to add, and the estimate is the
 * prompt alone.
 */
function budgetFor(req: {
  messages: readonly { content: string }[];
  maxTokens?: number;
}): number {
  return estimatePromptTokens(req.messages) + (req.maxTokens ?? 0);
}

/** Refused by this workspace's own spend cap, before anything was sent. */
export interface CappedOutcome {
  kind: "capped";
  message: string;
}

/**
 * Stream one completion against the workspace's configured model.
 *
 * The streaming twin of {@link completeWithWorkspaceModel}, and the same
 * contract: no exceptions, `not_configured` and `capped` as distinct outcomes,
 * and the adapter's events passed through untouched.
 *
 * `last_used_at` is stamped on the first delta rather than at the end. What it
 * answers is "is this connection actually serving the product", and by the time
 * a token has arrived that is already true. Waiting for the stream to finish
 * would leave a cancelled answer looking like the connection was never used,
 * which is the opposite of what happened.
 *
 * ── Why the ledger write is in a `finally` ──────────────────────────────────
 * A stream has three endings and all three cost money: it finishes, it fails
 * part way, or the reader goes away and the generator is closed from outside.
 * Only the first two arrive as events. Recording on the terminal event alone
 * would mean a cancelled answer left no trace, and a cancelled answer is
 * precisely the one somebody later fails to recognise on their invoice: tokens
 * were generated and billed, and nothing in the product ever mentioned them.
 * The `finally` runs on all three.
 */
export async function* streamWithWorkspaceModel(
  db: Database,
  workspaceId: string,
  req: StreamRequest,
  attribution: UsageAttribution,
): AsyncGenerator<StreamEvent | { kind: "not_configured" } | CappedOutcome> {
  const resolved = await resolveConfig(db, workspaceId);
  if (!resolved) {
    yield { kind: "not_configured" };
    return;
  }

  const allowance = await checkUsageAllowance(
    db,
    workspaceId,
    attribution,
    budgetFor(req),
  );
  if (!allowance.allowed) {
    // Not recorded in the ledger: nothing was sent, so nothing was spent, and a
    // ledger that contains calls which never happened cannot be reconciled
    // against an invoice.
    yield { kind: "capped", message: allowance.message };
    return;
  }

  let stamped = false;
  // Assume the worst until told otherwise. A generator abandoned mid-answer
  // never reaches an assignment after the loop, so the value that survives has
  // to be the one that is true at every point before the end.
  let outcome: "ok" | "error" | "cancelled" = "cancelled";
  let model: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorKind: string | null = null;

  try {
    for await (const event of createOpenAiCompatibleClient(resolved.config).stream(req)) {
      if (!stamped && (event.kind === "delta" || event.kind === "done")) {
        stamped = true;
        // Best effort, and deliberately not awaited into the critical path: a
        // token in flight must not wait on a bookkeeping write.
        void db
          .update(modelProviders)
          .set({ lastUsedAt: new Date() })
          .where(eq(modelProviders.id, resolved.id))
          .catch(() => {});
      }
      if (event.kind === "done") {
        outcome = "ok";
        model = event.model;
        promptTokens = event.usage.promptTokens;
        completionTokens = event.usage.completionTokens;
      } else if (event.kind === "error") {
        outcome = "error";
        errorKind = event.error.kind;
      }
      yield event;
    }
  } finally {
    await recordUsage(db, {
      workspaceId,
      ...attribution,
      model,
      promptTokens,
      completionTokens,
      outcome,
      errorKind,
    });
  }
}

/**
 * Run one completion against the workspace's configured model.
 *
 * The single entry point for unstreamed inference. Returns the adapter's
 * outcome verbatim so callers can branch on `error.kind`, plus distinct
 * `not_configured` and `capped` outcomes, because "no model connected" is a
 * setup prompt and "you have hit your cap" is a decision this workspace made,
 * and neither is a failure to report as one.
 */
export async function completeWithWorkspaceModel(
  db: Database,
  workspaceId: string,
  req: Parameters<ReturnType<typeof createOpenAiCompatibleClient>["complete"]>[0],
  attribution: UsageAttribution,
): Promise<
  | CompletionOutcome
  | { ok: false; error: { kind: "not_configured" } }
  | { ok: false; error: CappedOutcome }
> {
  const resolved = await resolveConfig(db, workspaceId);
  if (!resolved) return { ok: false, error: { kind: "not_configured" } };

  const allowance = await checkUsageAllowance(
    db,
    workspaceId,
    attribution,
    budgetFor(req),
  );
  if (!allowance.allowed) {
    return { ok: false, error: { kind: "capped", message: allowance.message } };
  }

  const client = createOpenAiCompatibleClient(resolved.config);
  const outcome = await client.complete(req);

  if (outcome.ok) {
    // Best effort: a successful call must not be reported as a failure because
    // the bookkeeping write lost a race or the row was deleted mid-flight.
    await db
      .update(modelProviders)
      .set({ lastUsedAt: new Date() })
      .where(eq(modelProviders.id, resolved.id))
      .catch(() => {});
  }

  await recordUsage(db, {
    workspaceId,
    ...attribution,
    model: outcome.ok ? outcome.model : null,
    promptTokens: outcome.ok ? outcome.usage.promptTokens : null,
    completionTokens: outcome.ok ? outcome.usage.completionTokens : null,
    outcome: outcome.ok ? "ok" : "error",
    errorKind: outcome.ok ? null : outcome.error.kind,
  });

  return outcome;
}
