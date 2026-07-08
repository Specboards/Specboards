import { createHash, randomBytes } from "node:crypto";

import {
  and,
  desc,
  eq,
  invitations,
  isNull,
  members,
  sql,
  users,
  type Database,
} from "@specboard/db";

import type { SessionUser } from "@/lib/auth-session";
import { renderActionEmail, sendEmail } from "@/lib/email";
import { MEMBER_ROLES, OrgMemberError } from "@/lib/org-members-service";
import type { OrgInvitationRecord, OrgRole } from "@/lib/store/types";

/**
 * Email-invitation flow for joining an org. An admin creates an invite (email +
 * role); we email an `/invite/<token>` link and store only the token's SHA-256.
 * The invitee signs in/up and redeems it, which inserts their `members` row.
 * Runs on the owner `getDb()` connection (like `workspace.ts`): the redeeming
 * user is not a member yet, so a tenant-scoped/RLS path would reject the write.
 */

const TOKEN_PREFIX = "sb_inv_";
const EXPIRY_DAYS = 7;

/** Raised when an invitation can't be created/redeemed; carries an HTTP status. */
export class InvitationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newToken(): { raw: string; hash: string } {
  const raw = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

function expiryFromNow(): Date {
  return new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/** Origin for the emailed link, from env (same source as the auth emails). */
function appOrigin(): string {
  return (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim().replace(/\/$/, "") ?? "";
}

/** Validate an untrusted invite body ({ email, role }). */
export function parseInvitationInput(body: unknown): { email: string; role: OrgRole } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvitationError("Request body must be a JSON object.", 400);
  }
  const raw = body as Record<string, unknown>;
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new InvitationError("A valid email address is required.", 400);
  }
  if (!MEMBER_ROLES.includes(raw.role as OrgRole)) {
    throw new InvitationError(`role must be one of: ${MEMBER_ROLES.join(", ")}.`, 400);
  }
  return { email, role: raw.role as OrgRole };
}

/** Effective status of a stored invite (a pending row past expiry reads expired). */
function effectiveStatus(row: typeof invitations.$inferSelect): OrgInvitationRecord["status"] {
  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) return "expired";
  return row.status;
}

function toRecord(row: typeof invitations.$inferSelect): OrgInvitationRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: effectiveStatus(row),
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether an active member with this (lowercased) email already exists. */
async function activeMemberWithEmail(
  db: Database,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        isNull(members.deactivatedAt),
        eq(sql`lower(${users.email})`, email),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function sendInviteEmail(email: string, rawToken: string): Promise<void> {
  const { textBody, htmlBody } = renderActionEmail({
    name: "there",
    intro:
      "You've been invited to join a Specboard workspace. Click below to accept the invitation. You'll sign in (or create an account) with this email address to join.",
    action: "Accept invitation",
    url: `${appOrigin()}/invite/${rawToken}`,
    footer: `This invitation expires in ${EXPIRY_DAYS} days. If you weren't expecting it, you can ignore this email.`,
  });
  await sendEmail({ to: email, subject: "You're invited to Specboard", textBody, htmlBody });
}

/** List an org's invitations, newest first (token never exposed). */
export async function listInvitations(
  db: Database,
  workspaceId: string,
): Promise<OrgInvitationRecord[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.workspaceId, workspaceId))
    .orderBy(desc(invitations.createdAt));
  return rows.map(toRecord);
}

/**
 * Create (or replace) a pending invitation for an email + role and send it.
 * Any prior pending invite for the same address is revoked so the partial-unique
 * `(workspace, lower(email)) where pending` index holds.
 */
export async function createInvitation(
  db: Database,
  workspaceId: string,
  invitedBy: string,
  email: string,
  role: OrgRole,
): Promise<OrgInvitationRecord> {
  if (await activeMemberWithEmail(db, workspaceId, email)) {
    throw new InvitationError(`${email} is already a member of this organization.`, 409);
  }

  const { raw, hash } = newToken();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(invitations)
      .set({ status: "revoked" })
      .where(
        and(
          eq(invitations.workspaceId, workspaceId),
          eq(sql`lower(${invitations.email})`, email),
          eq(invitations.status, "pending"),
        ),
      );
    const [inserted] = await tx
      .insert(invitations)
      .values({
        workspaceId,
        email,
        role,
        tokenHash: hash,
        invitedBy,
        expiresAt: expiryFromNow(),
      })
      .returning();
    return inserted!;
  });

  await sendInviteEmail(email, raw);
  return toRecord(row);
}

/** Revoke a pending invitation. No-op if already settled. */
export async function revokeInvitation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<void> {
  await db
    .update(invitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(invitations.id, id),
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.status, "pending"),
      ),
    );
}

/** Regenerate the token, refresh expiry, and re-send a pending invitation. */
export async function resendInvitation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, id), eq(invitations.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new InvitationError("That invitation no longer exists.", 404);
  if (row.status !== "pending") {
    throw new InvitationError("Only a pending invitation can be re-sent.", 422);
  }

  const { raw, hash } = newToken();
  await db
    .update(invitations)
    .set({ tokenHash: hash, expiresAt: expiryFromNow() })
    .where(eq(invitations.id, id));
  await sendInviteEmail(row.email, raw);
}

/** Outcome of redeeming a token, so the accept page can render precise states. */
export type RedeemResult =
  | { ok: true; workspaceId: string }
  | {
      ok: false;
      reason: "not_found" | "revoked" | "accepted" | "expired" | "email_mismatch";
      email?: string;
    };

/**
 * Redeem a raw invite token for a signed-in user: validate it, enforce the
 * strict email match, then insert/upgrade the `members` row and mark the invite
 * accepted. Idempotent-ish: a second redeem of an accepted invite returns the
 * `accepted` reason. Uses the owner connection (caller passes `getDb()`).
 */
export async function redeemInvitation(
  db: Database,
  rawToken: string,
  user: SessionUser,
): Promise<RedeemResult> {
  const [invite] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.status === "revoked") return { ok: false, reason: "revoked" };
  if (invite.status === "accepted") return { ok: false, reason: "accepted" };
  if (invite.status === "expired" || invite.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired", email: invite.email };
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return { ok: false, reason: "email_mismatch", email: invite.email };
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(members)
      .values({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role })
      .onConflictDoUpdate({
        target: [members.workspaceId, members.userId],
        set: { role: invite.role, deactivatedAt: null },
      });
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date(), acceptedUserId: user.id })
      .where(eq(invitations.id, invite.id));
  });

  return { ok: true, workspaceId: invite.workspaceId };
}

// Re-export so callers get a single import surface for guard errors.
export { OrgMemberError };
