import { randomBytes } from "node:crypto";

import { and, eq, members, users, type Database } from "@specboards/db";

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

export interface ServiceAccountSummary {
  userId: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CreateServiceAccountInput {
  name: string;
  /** Validated resource scopes for the account's key (empty = full access). */
  scopes: string[];
  expiresInDays: number | null;
  /**
   * Per-product grants to apply. When omitted, the account is granted
   * `contributor` on every product in the workspace so a sync bot can write
   * out of the box; pass an explicit (possibly empty) list to narrow it.
   */
  productGrants?: { productId: string; role: ProductRole }[];
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

  let expiresInDays: number | null = null;
  if (raw.expiresInDays != null) {
    const days = Number(raw.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) {
      throw new ServiceAccountError("expiresInDays must be between 1 and 3650.");
    }
    expiresInDays = days;
  }

  let productGrants: CreateServiceAccountInput["productGrants"];
  if (raw.productGrants !== undefined) {
    if (!Array.isArray(raw.productGrants)) {
      throw new ServiceAccountError("productGrants must be an array.");
    }
    productGrants = raw.productGrants.map((g) => {
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
  }

  return { name, scopes, expiresInDays, productGrants };
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

  // Grant product access so the bot can actually write. Default: contributor on
  // every product (a sync bot spans the workspace); explicit grants override.
  const grants =
    input.productGrants ??
    (await listProducts(scope)).map((p) => ({
      productId: p.id,
      role: "contributor" as ProductRole,
    }));
  for (const grant of grants) {
    await setProductMember(grant.productId, { userId: user.id, role: grant.role }, scope);
  }

  const expiresAt =
    input.expiresInDays != null
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
  const key = await createApiKey(db, user.id, `${input.name} key`, expiresAt, input.scopes);

  return {
    account: {
      userId: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
    },
    key,
  };
}

/** List the workspace's service accounts (bot members), newest first. */
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
  return rows
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      createdAt: r.createdAt.toISOString(),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
