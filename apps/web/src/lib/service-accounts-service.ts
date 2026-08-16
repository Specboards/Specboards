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
import { parseApiScopes } from "@/lib/api-scopes";
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
 * The two cases exist for two different callers. The CI sync bot is set up by
 * `curl`ing `POST /api/v1/org/service-accounts` with just a name and scopes
 * (see docs/RUNBOOK-specboard-dogfood.md), and has always meant "contributor
 * everywhere"; breaking that would break the documented setup. A customer's
 * agent, created from Settings, must never get that sweep by omission, so the
 * UI always sends an explicit list, even an empty one.
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
  /** Scopes on the account's live key; `[]` means unrestricted. */
  scopes: string[];
  productGrants: ProductGrant[];
  /** The live (unrevoked) key, or null once every key has been revoked. */
  key: ServiceAccountKeyView | null;
}

export interface CreateServiceAccountInput {
  name: string;
  /** Validated resource scopes for the account's key (empty = full access). */
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
    scopes = parseApiScopes(raw.scopes);
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
 * Read the grant policy off an untrusted body. An omitted `productGrants` is
 * the legacy CI-bot shape and still means "contributor on everything"; any
 * array, including an empty one, is taken literally.
 */
function parseGrantPolicy(raw: unknown): ProductGrantPolicy {
  if (raw === undefined) return { kind: "every-product-contributor" };
  if (!Array.isArray(raw)) {
    throw new ServiceAccountError("productGrants must be an array.");
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
 * Create a service account: a bot user, a `service` membership, its product
 * grants, and one API key (plaintext returned exactly once). Runs against the
 * owner connection for the auth rows and the tenant store (owner scope) for the
 * grants.
 */
export async function createServiceAccount(
  db: Database,
  workspaceId: string,
  input: CreateServiceAccountInput,
  scope: WorkspaceScope,
): Promise<{ account: ServiceAccountSummary; key: GeneratedApiKey }> {
  const [user] = await db
    .insert(users)
    .values({ name: input.name, email: botEmail(), emailVerified: false })
    .returning({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt });
  if (!user) throw new ServiceAccountError("Failed to create the service user.");

  await db
    .insert(members)
    .values({ workspaceId, userId: user.id, role: "service" })
    .onConflictDoNothing({ target: [members.workspaceId, members.userId] });

  // Grant product access so the account can actually write. The policy is
  // always stated by the caller; there is no "grants omitted" branch here.
  const grants =
    input.grantPolicy.kind === "explicit"
      ? input.grantPolicy.grants
      : (await listProducts(scope)).map((p) => ({
          productId: p.id,
          role: "contributor" as ProductRole,
        }));
  for (const grant of grants) {
    await setProductMember(grant.productId, { userId: user.id, role: grant.role }, scope);
  }

  const key = await createApiKey(
    db,
    user.id,
    `${input.name} key`,
    expiresAtFrom(input.expiresInDays),
    input.scopes,
  );

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

  const live = await db
    .select({ scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
    .orderBy(sql`${apiKeys.createdAt} desc`)
    .limit(1);

  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));

  return createApiKey(
    db,
    userId,
    `${account.name} key`,
    expiresAtFrom(expiresInDays),
    live[0]?.scopes ?? [],
  );
}
