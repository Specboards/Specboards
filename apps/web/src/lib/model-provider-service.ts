import {
  eq,
  modelProviderCredentials,
  modelProviders,
  type Database,
} from "@specboards/db";

import { assertReachableModelUrl } from "@/lib/ai/egress";
import { createOpenAiCompatibleClient } from "@/lib/ai/openai-compatible";
import type { CompletionOutcome, ProviderConfig } from "@/lib/ai/provider";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

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
 * Run one completion against the workspace's configured model.
 *
 * The single entry point for inference. Returns the adapter's outcome verbatim
 * so callers can branch on `error.kind`, plus a distinct `not_configured`
 * outcome, because "no model connected" is a setup prompt rather than a failure
 * to report.
 */
export async function completeWithWorkspaceModel(
  db: Database,
  workspaceId: string,
  req: Parameters<ReturnType<typeof createOpenAiCompatibleClient>["complete"]>[0],
): Promise<CompletionOutcome | { ok: false; error: { kind: "not_configured" } }> {
  const resolved = await resolveConfig(db, workspaceId);
  if (!resolved) return { ok: false, error: { kind: "not_configured" } };

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
  return outcome;
}
