"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  createInvitation,
  listInvitations,
  listOrgMembers,
  removeOrgMember,
  resendInvitation,
  revokeInvitation,
  updateOrgMember,
} from "@/lib/api-client";
import type {
  InvitationProductGrant,
  MemberDisplayRole,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgRole,
  ProductRole,
} from "@/lib/store/types";

/** A product the owner can grant invitees access to. */
export interface InviteProduct {
  id: string;
  name: string;
}

const ORG_ROLES: OrgRole[] = ["owner", "member"];

const ORG_ROLE_LABEL: Record<MemberDisplayRole, string> = {
  owner: "Owner",
  member: "Member",
  service: "Service",
};

const PRODUCT_ROLES: ProductRole[] = ["admin", "contributor", "viewer"];

const PRODUCT_ROLE_LABEL: Record<ProductRole, string> = {
  admin: "Admin",
  contributor: "Contributor",
  viewer: "Viewer",
};

/** Sentinel for "no access to this product" in the grant picker. */
const NO_ACCESS = "";

function onAuthError() {
  window.location.href = "/sign-in";
}

/**
 * The org's Team roster (Settings → Company & Team). Everyone sees the member
 * list; the owner additionally gets role controls (Owner/Member), remove,
 * deactivate/reactivate, an "Invite a teammate" form (with per-product access),
 * and the pending-invitations list. Real per-product capability is granted on
 * the Products page; the org role here is just Owner vs. Member. Mutations go
 * through the owner-gated /api/v1/org endpoints; the last-owner guard is
 * enforced server-side and surfaced here as a toast.
 */
export function OrgMembers({
  initialMembers,
  currentUserId,
  canManage,
  products,
}: {
  initialMembers: OrgMemberRecord[];
  currentUserId: string;
  canManage: boolean;
  products: InviteProduct[];
}) {
  const [members, setMembers] = useState<OrgMemberRecord[]>(initialMembers);
  const [invites, setInvites] = useState<OrgInvitationRecord[] | null>(null);
  const [pending, startTransition] = useTransition();

  // The owner loads pending invitations lazily (the endpoint is owner-only).
  useEffect(() => {
    if (!canManage) return;
    let active = true;
    listInvitations()
      .then((rows) => {
        if (active) setInvites(rows);
      })
      .catch(() => {
        if (active) setInvites([]);
      });
    return () => {
      active = false;
    };
  }, [canManage]);

  async function refreshMembers() {
    try {
      setMembers(await listOrgMembers());
    } catch (err) {
      if (err instanceof AuthRequiredError) return onAuthError();
    }
  }

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(
          err instanceof Error ? err.message : "Something went wrong.",
        );
      }
    });
  }

  const activeOwners = members.filter(
    (m) => m.role === "owner" && !m.deactivatedAt,
  ).length;

  function changeRole(m: OrgMemberRecord, role: OrgRole) {
    run(async () => {
      await updateOrgMember(m.userId, { role });
      await refreshMembers();
    });
  }

  function toggleActive(m: OrgMemberRecord) {
    const active = m.deactivatedAt !== null; // reactivating if currently deactivated
    run(async () => {
      await updateOrgMember(m.userId, { active });
      await refreshMembers();
    });
  }

  function remove(m: OrgMemberRecord) {
    run(async () => {
      await removeOrgMember(m.userId);
      setMembers((ms) => ms.filter((x) => x.userId !== m.userId));
    });
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Members</h2>
        <ul className="divide-y rounded-md border">
          {members.map((m) => {
            const isSelf = m.userId === currentUserId;
            const isLastOwner =
              m.role === "owner" && !m.deactivatedAt && activeOwners <= 1;
            return (
              <li
                key={m.userId}
                className="flex items-center gap-3 px-3 py-2.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {m.name}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {m.email}
                  </span>
                  {m.deactivatedAt ? (
                    <Badge variant="secondary" className="ml-2 align-middle">
                      Deactivated
                    </Badge>
                  ) : null}
                </span>
                {canManage && m.role !== "service" ? (
                  <>
                    <Select
                      value={m.role}
                      disabled={pending || isLastOwner}
                      onChange={(e) => changeRole(m, e.target.value as OrgRole)}
                      className="h-8 w-32"
                      title={
                        isLastOwner
                          ? "Make someone else an owner first."
                          : undefined
                      }
                    >
                      {ORG_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ORG_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending || isSelf || isLastOwner}
                      className="text-muted-foreground"
                      onClick={() => toggleActive(m)}
                      title={
                        isSelf ? "You can't deactivate yourself." : undefined
                      }
                    >
                      {m.deactivatedAt ? "Reactivate" : "Deactivate"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending || isSelf || isLastOwner}
                      className="text-destructive"
                      onClick={() => remove(m)}
                      title={isSelf ? "You can't remove yourself." : undefined}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Badge variant="outline">{ORG_ROLE_LABEL[m.role]}</Badge>
                )}
              </li>
            );
          })}
        </ul>
        {canManage ? (
          <p className="text-xs text-muted-foreground">
            An Owner administers the whole workspace. Everyone else is a Member
            (read-only at the org); grant them per-product access below or on
            the Products page.
          </p>
        ) : null}
      </section>

      {canManage ? (
        <>
          <InviteForm
            products={products}
            disabled={pending}
            onInvited={(inv) => setInvites((rows) => [inv, ...(rows ?? [])])}
          />
          <PendingInvites
            invites={invites}
            disabled={pending}
            onChanged={() =>
              listInvitations()
                .then(setInvites)
                .catch(() => {})
            }
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * "Invite a teammate" form: an email, an org role (Owner or Member), and - for a
 * Member - a per-product access picker. One invite can grant several products at
 * once; each product's dropdown chooses No access / Viewer / Contributor /
 * Admin. Owner invites skip product access (an owner administers everything).
 */
function InviteForm({
  products,
  disabled,
  onInvited,
}: {
  products: InviteProduct[];
  disabled: boolean;
  onInvited: (inv: OrgInvitationRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  // productId → chosen product role, or NO_ACCESS.
  const [grants, setGrants] = useState<
    Record<string, ProductRole | typeof NO_ACCESS>
  >({});
  const [pending, startTransition] = useTransition();

  function setGrant(productId: string, value: ProductRole | typeof NO_ACCESS) {
    setGrants((g) => ({ ...g, [productId]: value }));
  }

  function reset() {
    setEmail("");
    setRole("member");
    setGrants({});
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    const productGrants: InvitationProductGrant[] =
      role === "member"
        ? Object.entries(grants)
            .filter(([, r]) => r !== NO_ACCESS)
            .map(([productId, r]) => ({ productId, role: r as ProductRole }))
        : [];
    startTransition(async () => {
      try {
        const inv = await createInvitation({
          email: address,
          role,
          productGrants,
        });
        onInvited(inv);
        reset();
        setOpen(false);
        toast.success(`Invitation sent to ${address}.`);
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Invite failed.");
      }
    });
  }

  return (
    <section className="space-y-3">
      {/* Start as an "Invite teammate" affordance; reveal the form on opt-in
          (see the "add" UX rule in CLAUDE.md). */}
      {open ? (
        <>
          <h2 className="text-sm font-semibold">Invite a teammate</h2>
          <form onSubmit={submit} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                className="h-9 w-64"
                aria-label="Teammate email"
                autoFocus
              />
              <Select
                value={role}
                onChange={(e) => setRole(e.target.value as OrgRole)}
                className="h-9 w-32"
                aria-label="Org role"
              >
                {ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ORG_ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
              <Button
                type="submit"
                size="sm"
                disabled={disabled || pending || !email.trim()}
              >
                Send invite
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  reset();
                  setOpen(false);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>

            {role === "member" && products.length > 0 ? (
              <div className="space-y-1.5 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Product access (optional)
                </p>
                <ul className="space-y-1.5">
                  {products.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <Select
                        value={grants[p.id] ?? NO_ACCESS}
                        disabled={pending}
                        onChange={(e) =>
                          setGrant(
                            p.id,
                            e.target.value as ProductRole | typeof NO_ACCESS,
                          )
                        }
                        className="h-8 w-36"
                        aria-label={`${p.name} access`}
                      >
                        <option value={NO_ACCESS}>No access</option>
                        {PRODUCT_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {PRODUCT_ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </form>
          <p className="text-xs text-muted-foreground">
            {role === "owner"
              ? "An owner administers the entire workspace."
              : "Members are read-only at the org until you grant them product access. You can adjust access anytime on the Products page."}{" "}
            The invite is an email link that expires after 7 days.
          </p>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          Invite teammate
        </Button>
      )}
    </section>
  );
}

/** The org's outstanding (pending) invitations, with resend/revoke. */
function PendingInvites({
  invites,
  disabled,
  onChanged,
}: {
  invites: OrgInvitationRecord[] | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();

  if (invites === null) {
    return (
      <p className="text-xs text-muted-foreground">Loading invitations…</p>
    );
  }
  const rows = invites.filter((i) => i.status === "pending");
  if (rows.length === 0) return null;

  function act(action: () => Promise<void>, done: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(done);
        onChanged();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Action failed.");
      }
    });
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Pending invitations</h2>
      <ul className="divide-y rounded-md border">
        {rows.map((inv) => {
          const summary =
            inv.role === "owner"
              ? "Owner"
              : inv.productGrants.length > 0
                ? `Member · ${inv.productGrants.length} product${inv.productGrants.length > 1 ? "s" : ""}`
                : "Member";
          return (
            <li
              key={inv.id}
              className="flex items-center gap-3 px-3 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {inv.email}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {summary}
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || pending}
                className="text-muted-foreground"
                onClick={() =>
                  act(() => resendInvitation(inv.id), "Invitation re-sent.")
                }
              >
                Resend
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled || pending}
                className="text-destructive"
                onClick={() =>
                  act(() => revokeInvitation(inv.id), "Invitation revoked.")
                }
              >
                Revoke
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
