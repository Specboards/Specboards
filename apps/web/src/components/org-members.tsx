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
import type { OrgInvitationRecord, OrgMemberRecord, OrgRole } from "@/lib/store/types";

const ROLES: OrgRole[] = ["admin", "pm", "ux", "eng", "viewer"];

/** Display labels for the org roles. */
const ROLE_LABEL: Record<OrgRole, string> = {
  admin: "Admin",
  pm: "PM",
  ux: "UX",
  eng: "Engineering",
  viewer: "Viewer",
};

function onAuthError() {
  window.location.href = "/sign-in";
}

/**
 * The org's Team roster (Settings → Company & Team). Everyone sees the member
 * list; admins additionally get role controls, remove, deactivate/reactivate,
 * an "Invite by email" form, and the pending-invitations list. All mutations
 * go through the org-admin-gated /api/v1/org endpoints; the last-admin guard is
 * enforced server-side and surfaced here as a toast.
 */
export function OrgMembers({
  initialMembers,
  currentUserId,
  canManage,
}: {
  initialMembers: OrgMemberRecord[];
  currentUserId: string;
  canManage: boolean;
}) {
  const [members, setMembers] = useState<OrgMemberRecord[]>(initialMembers);
  const [invites, setInvites] = useState<OrgInvitationRecord[] | null>(null);
  const [pending, startTransition] = useTransition();

  // Admins load pending invitations lazily (the endpoint is admin-only).
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
        toast.error(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  const activeAdmins = members.filter((m) => m.role === "admin" && !m.deactivatedAt).length;

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
            const isLastAdmin = m.role === "admin" && !m.deactivatedAt && activeAdmins <= 1;
            return (
              <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {m.name}
                  <span className="ml-1.5 text-xs text-muted-foreground">{m.email}</span>
                  {m.deactivatedAt ? (
                    <Badge variant="secondary" className="ml-2 align-middle">
                      Deactivated
                    </Badge>
                  ) : null}
                </span>
                {canManage ? (
                  <>
                    <Select
                      value={m.role}
                      disabled={pending || isLastAdmin}
                      onChange={(e) => changeRole(m, e.target.value as OrgRole)}
                      className="h-8 w-32"
                      title={isLastAdmin ? "Promote another admin first." : undefined}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending || isSelf || isLastAdmin}
                      className="text-muted-foreground"
                      onClick={() => toggleActive(m)}
                      title={isSelf ? "You can't deactivate yourself." : undefined}
                    >
                      {m.deactivatedAt ? "Reactivate" : "Deactivate"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending || isSelf || isLastAdmin}
                      className="text-destructive"
                      onClick={() => remove(m)}
                      title={isSelf ? "You can't remove yourself." : undefined}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Badge variant="outline">{ROLE_LABEL[m.role]}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {canManage ? (
        <>
          <InviteForm
            disabled={pending}
            onInvited={(inv) => setInvites((rows) => [inv, ...(rows ?? [])])}
          />
          <PendingInvites
            invites={invites}
            disabled={pending}
            onChanged={() => listInvitations().then(setInvites).catch(() => {})}
          />
        </>
      ) : null}
    </div>
  );
}

/** "Invite by email" form: an address + a role. */
function InviteForm({
  disabled,
  onInvited,
}: {
  disabled: boolean;
  onInvited: (inv: OrgInvitationRecord) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("viewer");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    startTransition(async () => {
      try {
        const inv = await createInvitation({ email: address, role });
        onInvited(inv);
        setEmail("");
        setRole("viewer");
        toast.success(`Invitation sent to ${address}.`);
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Invite failed.");
      }
    });
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Invite a teammate</h2>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="h-9 w-64"
        />
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as OrgRole)}
          className="h-9 w-32"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Button type="submit" size="sm" disabled={disabled || pending || !email.trim()}>
          Send invite
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        They get an email link to join with the role you pick. Invitations expire
        after 7 days.
      </p>
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
    return <p className="text-xs text-muted-foreground">Loading invitations…</p>;
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
        {rows.map((inv) => (
          <li key={inv.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {inv.email}
              <span className="ml-1.5 text-xs text-muted-foreground">
                {ROLE_LABEL[inv.role]}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              className="text-muted-foreground"
              onClick={() => act(() => resendInvitation(inv.id), "Invitation re-sent.")}
            >
              Resend
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || pending}
              className="text-destructive"
              onClick={() => act(() => revokeInvitation(inv.id), "Invitation revoked.")}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
