import { randomBytes } from "node:crypto";

import {
  and,
  apiKeys,
  eq,
  inArray,
  isNull,
  members,
  productMembers,
  sql,
  users,
  type Database,
} from "@specboards/db";

import { createApiKey, type GeneratedApiKey } from "@/lib/api-keys";
import { parseGrantedScopes } from "@/lib/api-scopes";
import { listProducts, setProductMember } from "@/lib/products-service";
import type { ProductRole, WorkspaceScope } from "@/lib/store/types";

/**
 * Service (bot) accounts: non-human workspace members for automation like the
 * `specboards-sync` CI loop. A service account is a real `users` row with no
 * login credentials (so it can never sign in) plus a `members` row with the
 * `service` role, so its activity (status changes, PR links, comments) is
 * attributed to a clearly-labelled identity instead of a human admin.
 *
 * Membership/users are auth data, so this uses the owner `getDb()` connection
 * directly (mirroring `org-members-service.ts`); per-product grants are tenant
 * data and go through the store with the creating owner's scope.
 */

export class ServiceAccountError extends Error {}

const NAME_MAX = 80;

export interface ProductGrant {
  productId: string;
  role: ProductRole;
}

/**
 * What product access a new account gets, always stated rather than defaulted.
 *
 * The two cases exist for two different shapes of caller. A workspace-wide CI
 * sync bot genuinely wants contributor on everything; a customer's agent wants
 * the products that were ticked.
 *
 * Both are now asked for explicitly. `every-product-contributor` used to be
 * what you got by *omitting* `productGrants`, which made silence the broadest
 * answer available on the endpoint that mints credentials, and left the UI
 * compensating by always sending a list. It is now reached by sending
 * `productGrants: "*"`, so the sweep is a decision on the record.
 *
 * Making the policy a named value rather than an `undefined` check keeps the
 * choice visible at the call site instead of buried in a default.
 */
export type ProductGrantPolicy =
  | { kind: "explicit"; grants: ProductGrant[] }
  | { kind: "every-product-contributor" };

/** The live API key behind an agent, without any secret material. */
export interface ServiceAccountKeyView {
  id: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ServiceAccountSummary {
  userId: string;
  name: string;
  email: string;
  createdAt: string;
  /**
   * Scopes on the account's live key. `[]` means unrestricted, and still
   * appears here for accounts created before scopes were required; new ones
   * cannot be minted that way.
   */
  scopes: string[];
  productGrants: ProductGrant[];
  /** The live (unrevoked) key, or null once every key has been revoked. */
  key: ServiceAccountKeyView | null;
}

export interface CreateServiceAccountInput {
  name: string;
  /** Validated resource scopes, never empty. `["*"]` is how full access is asked for. */
  scopes: string[];
  expiresInDays: number | null;
  grantPolicy: ProductGrantPolicy;
}

/** Parse + validate an untrusted create body. */
export function parseCreateServiceAccountInput(
  body: unknown,
): CreateServiceAccountInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceAccountError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    throw new ServiceAccountError(`A name (1-${NAME_MAX} chars) is required.`);
  }

  let scopes: string[];
  try {
    // Strict on creation: an absent list is not read as full access here, the
    // way it is when checking an existing key. See `parseGrantedScopes`.
    scopes = parseGrantedScopes(raw.scopes);
  } catch (err) {
    throw new ServiceAccountError((err as Error).message);
  }

  const expiresInDays = parseExpiresInDays(raw.expiresInDays);

  return {
    name,
    scopes,
    expiresInDays,
    grantPolicy: parseGrantPolicy(raw.productGrants),
  };
}

/**
 * Read the grant policy off an untrusted body.
 *
 * An omitted `productGrants` used to mean "contributor on everything", which is
 * what the documented CI-bot `curl` relied on. That made silence the broadest
 * possible answer on the endpoint that mints credentials, and the UI had to
 * work around it by always sending a list "even an empty one" - a client-side
 * guard on a server-side decision, which a direct API caller simply skips.
 *
 * The sweep is still available and now has to be asked for: `productGrants:
 * "*"`. Same access, stated rather than inferred. `[]` remains literal, and an
 * array is taken as written.
 */
function parseGrantPolicy(raw: unknown): ProductGrantPolicy {
  if (raw === "*") return { kind: "every-product-contributor" };
  if (raw === undefined || raw === null) {
    throw new ServiceAccountError(
      'productGrants is required. Pass "*" for contributor on every product, ' +
        "[] for none, or a list of { productId, role }.",
    );
  }
  if (!Array.isArray(raw)) {
    throw new ServiceAccountError(
      'productGrants must be an array, or "*" for every product.',
    );
  }
  const grants = raw.map((g): ProductGrant => {
    const grant = g as Record<string, unknown>;
    if (typeof grant.productId !== "string") {
      throw new ServiceAccountError("Each productGrant needs a productId.");
    }
    const role = grant.role;
    if (role !== "admin" && role !== "contributor" && role !== "viewer") {
      throw new ServiceAccountError(
        "productGrant.role must be admin, contributor, or viewer.",
      );
    }
    return { productId: grant.productId, role };
  });
  return { kind: "explicit", grants };
}

/** Days-to-expiry for a rotate request, validated the same way creation is. */
export function parseExpiresInDays(raw: unknown): number | null {
  if (raw == null) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new ServiceAccountError("expiresInDays must be between 1 and 3650.");
  }
  return days;
}

/** A synthetic, non-routable email for a bot user; the unique index dedupes. */
function botEmail(): string {
  return `svc-${randomBytes(9).toString("hex")}@service.specboard.local`;
}

/**
 * Resolve the grant policy into the grants to apply, refusing any product id
 * that is not one of this workspace's.
 *
 * Up front, before anything is written. An unknown or malformed id used to
 * surface from `setProductMember` half way through creation, after the bot user
 * and its membership already existed, leaving an account with grants and no
 * key. That state is worse than a failed create: settings renders it as "no
 * live key, Unrestricted" and offers a Rotate button, which is how a broken
 * create turned into a credential question. `parseInvitationInput` validates
 * its own product ids the same way.
 */
async function resolveGrants(
  policy: ProductGrantPolicy,
  scope: WorkspaceScope,
): Promise<ProductGrant[]> {
  const products = await listProducts(scope);
  if (policy.kind !== "explicit") {
    return products.map((p) => ({ productId: p.id, role: "contributor" as ProductRole }));
  }
  const known = new Set(products.map((p) => p.id));
  for (const grant of policy.grants) {
    if (!known.has(grant.productId)) {
      throw new ServiceAccountError(
        `No such product in this workspace: "${grant.productId}".`,
      );
    }
  }
  return policy.grants;
}

/**
 * Undo a create that failed part way through.
 *
 * The grants live on the tenant store connection and the auth rows on the owner
 * one, so no single transaction can cover both. Compensating instead: whatever
 * exists of this account goes away, because a half-built agent is not a
 * harmless leftover. Best effort by design, and the original failure is what
 * the caller sees either way.
 */
async function undoHalfBuiltAccount(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    await db
      .delete(productMembers)
      .where(
        and(eq(productMembers.workspaceId, workspaceId), eq(productMembers.userId, userId)),
      );
    await db
      .delete(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
    await db.delete(users).where(eq(users.id, userId));
  } catch (err) {
    // Nothing better to do: this is already the error path, and the account is
    // reported as not created either way. Log it so an operator can find the
    // orphan rather than discovering them later with no explanation.
    console.error("[service-accounts] could not undo a failed create:", err);
  }
}

/**
 * Create a service account: a bot user, a `service` membership, its product
 * grants, and one API key (plaintext returned exactly once). Runs against the
 * owner connection for the auth rows and the tenant store (owner scope) for the
 * grants.
 *
 * Either the whole account exists or none of it does. The two auth rows go in
 * one transaction, and anything that fails after them takes the account with
 * it: an agent with no key is the state that made rotation mint an unrestricted
 * credential, so it must not be reachable by a failed create.
 */
export async function createServiceAccount(
  db: Database,
  workspaceId: string,
  input: CreateServiceAccountInput,
  scope: WorkspaceScope,
): Promise<{ account: ServiceAccountSummary; key: GeneratedApiKey }> {
  // Before any writes, so the common failure leaves nothing behind at all.
  const grants = await resolveGrants(input.grantPolicy, scope);

  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ name: input.name, email: botEmail(), emailVerified: false })
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      });
    if (!created) throw new ServiceAccountError("Failed to create the service user.");

    await tx
      .insert(members)
      .values({ workspaceId, userId: created.id, role: "service" })
      .onConflictDoNothing({ target: [members.workspaceId, members.userId] });
    return created;
  });

  let key: GeneratedApiKey;
  try {
    for (const grant of grants) {
      await setProductMember(grant.productId, { userId: user.id, role: grant.role }, scope);
    }

    key = await createApiKey(
      db,
      user.id,
      `${input.name} key`,
      expiresAtFrom(input.expiresInDays),
      input.scopes,
    );
  } catch (err) {
    await undoHalfBuiltAccount(db, workspaceId, user.id);
    throw err;
  }

  return {
    account: {
      userId: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
      scopes: key.scopes,
      productGrants: grants,
      key: {
        id: key.id,
        prefix: key.prefix,
        lastUsedAt: null,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      },
    },
    key,
  };
}

/** Absolute expiry for a lifetime in days, or null for a key that never expires. */
function expiresAtFrom(days: number | null): Date | null {
  return days != null ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
}

/**
 * List the workspace's service accounts (bot members), newest first, with what
 * an owner needs in order to judge one: the scopes its key carries, the
 * products it can reach, and when it was last used.
 *
 * Three queries rather than one join per account: the accounts, then their keys
 * and their product grants in one `in (...)` each. A settings page listing a
 * handful of agents should not fan out into a query per row.
 */
export async function listServiceAccounts(
  db: Database,
  workspaceId: string,
): Promise<ServiceAccountSummary[]> {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.workspaceId, workspaceId), eq(members.role, "service")));
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.userId);
  const keys = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(and(inArray(apiKeys.userId, userIds), isNull(apiKeys.revokedAt)))
    .orderBy(sql`${apiKeys.createdAt} desc`);
  const grants = await db
    .select({
      userId: productMembers.userId,
      productId: productMembers.productId,
      role: productMembers.role,
    })
    .from(productMembers)
    .where(
      and(
        eq(productMembers.workspaceId, workspaceId),
        inArray(productMembers.userId, userIds),
      ),
    );

  // Newest live key per account. Rotation revokes the old one, so in practice
  // there is at most one; ordering by createdAt keeps it deterministic anyway.
  const keyByUser = new Map<string, (typeof keys)[number]>();
  for (const k of keys) if (!keyByUser.has(k.userId)) keyByUser.set(k.userId, k);

  return rows
    .map((r) => {
      const key = keyByUser.get(r.userId);
      return {
        userId: r.userId,
        name: r.name,
        email: r.email,
        createdAt: r.createdAt.toISOString(),
        scopes: key?.scopes ?? [],
        productGrants: grants
          .filter((g) => g.userId === r.userId)
          .map((g) => ({ productId: g.productId, role: g.role })),
        key: key
          ? {
              id: key.id,
              prefix: key.prefix,
              lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
              expiresAt: key.expiresAt?.toISOString() ?? null,
              createdAt: key.createdAt.toISOString(),
            }
          : null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Confirm `userId` is a service account of `workspaceId`, so an owner cannot
 * aim revoke/rotate at a human member or at another workspace's bot by id.
 */
async function requireServiceMember(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const [row] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        eq(members.userId, userId),
        eq(members.role, "service"),
      ),
    )
    .limit(1);
  if (!row) throw new ServiceAccountError("No such agent in this workspace.");
}

/**
 * Revoke an agent: kill its keys, drop its workspace membership and every
 * product grant. Takes effect on the agent's next call, since keys are checked
 * per request rather than cached.
 *
 * The `users` row deliberately survives. Item history references it to render
 * "Atlas bot (agent)", and deleting it would turn every edit the agent ever
 * made into an unattributed "Someone" - the opposite of why agents get their
 * own identity.
 */
export async function revokeServiceAccount(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await requireServiceMember(db, workspaceId, userId);
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  await db
    .delete(productMembers)
    .where(
      and(
        eq(productMembers.workspaceId, workspaceId),
        eq(productMembers.userId, userId),
      ),
    );
  await db
    .delete(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}

/**
 * Rotate an agent's key: revoke every live key and mint one replacement with
 * the same scopes, returning the plaintext exactly once.
 *
 * Scopes are carried over rather than re-chosen, so rotation is a credential
 * operation and not a quiet re-authorization. The expiry is not carried over:
 * the original lifetime is not stored, only the absolute date, and reusing that
 * would mint an already-expired key. The caller states it, as at creation.
 */
export async function rotateServiceAccountKey(
  db: Database,
  workspaceId: string,
  userId: string,
  expiresInDays: number | null,
): Promise<GeneratedApiKey> {
  await requireServiceMember(db, workspaceId, userId);
  const [account] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!account) throw new ServiceAccountError("No such agent in this workspace.");

  const [previous] = await db
    .select({ scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(sql`${apiKeys.createdAt} desc`)
    .limit(1);

  // Rotation copies the previous key's scopes, so with no key to copy from
  // there is nothing to copy. This used to fall back to `[]`, which is not "no
  // access" but *unrestricted*: an empty list means a legacy full-access key at
  // all three enforcement points. An account left without a key would rotate
  // itself into the broadest credential the system can issue, from a button
  // whose tooltip promises the same scopes as before.
  //
  // There is no correct answer to "the same scopes as what?", so refuse instead
  // of guessing at the permissive end. Unlike creation, rotate has nowhere to
  // put a stated scope list: it is a credential operation by design, not a
  // re-authorization, and widening it into one would be the bigger change.
  if (!previous) {
    throw new ServiceAccountError(
      "This agent has no live key, so there are no scopes to carry over to a " +
        "new one. Revoke the agent and create it again with the scopes it needs.",
    );
  }

  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));

  return createApiKey(
    db,
    userId,
    `${account.name} key`,
    expiresAtFrom(expiresInDays),
    previous.scopes,
  );
}
