"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  scopesFromLevels,
  type ScopeLevel,
} from "@/lib/agent-scopes";
import type { ScopeResource } from "@/lib/api-scopes";

export interface AgentProductGrant {
  productId: string;
  role: "admin" | "contributor" | "viewer";
}

export interface AgentView {
  userId: string;
  name: string;
  createdAt: string;
  scopes: string[];
  productGrants: AgentProductGrant[];
  key: {
    id: string;
    prefix: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  } | null;
}

export interface AgentProduct {
  id: string;
  name: string;
}

type Status = { kind: "ok" | "error"; message: string } | null;
type GrantRole = AgentProductGrant["role"] | "none";

/** Lifetime a rotated key gets. Stated on the button so it is never a surprise. */
const ROTATE_LIFETIME_DAYS = 90;

const EXPIRY_CHOICES = [
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "30", label: "30 days" },
  { value: "", label: "Never expires" },
];

/**
 * Date-only options, shared so the value is a stable identity rather than a
 * fresh object on every render. See {@link LocalTime} for why a timestamp is a
 * component here and not a string: formatting one during SSR breaks hydration
 * and takes this card's buttons with it.
 */
const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/** "12 read, 4 write" - enough to judge an agent without opening anything. */
function describeScopes(scopes: string[]): string {
  if (scopes.length === 0) return "Unrestricted (full access of its owner)";
  const writes = scopes.filter((s) => s.endsWith(":write")).length;
  const reads = scopes.length - writes;
  const parts: string[] = [];
  if (reads) parts.push(`${reads} read`);
  if (writes) parts.push(`${writes} write`);
  return parts.join(", ");
}

/**
 * Agent identities: login-less workspace members a customer points their own
 * coding agent at, each with its own scoped, separately-revocable key.
 *
 * Distinct from a personal API key, which authenticates as its owner and
 * inherits everything that person can do. An agent is its own member, so its
 * writes are attributable to it, it can be granted less than a person has, and
 * revoking it does not touch its creator's access.
 */
export function AgentsCard({
  initialAgents,
  products,
  canManage,
}: {
  initialAgents: AgentView[];
  products: AgentProduct[];
  canManage: boolean;
}) {
  const [agents, setAgents] = useState<AgentView[]>(initialAgents);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [levels, setLevels] = useState<Partial<Record<ScopeResource, ScopeLevel>>>(
    {},
  );
  const [grants, setGrants] = useState<Record<string, GrantRole>>({});
  const [status, setStatus] = useState<Status>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  function resetForm() {
    setName("");
    setExpiry("90");
    setLevels({});
    setGrants({});
    setStatus(null);
  }

  function openForm() {
    resetForm();
    setAdding(true);
  }

  const selectedScopes = scopesFromLevels(levels);
  const selectedGrants = Object.entries(grants)
    .filter(([, role]) => role !== "none")
    .map(([productId, role]) => ({
      productId,
      role: role as AgentProductGrant["role"],
    }));

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Give the agent a name first." });
      return;
    }
    // An empty scope list is read as UNRESTRICTED by the key layer, so an agent
    // created with nothing ticked would silently be the most powerful kind. The
    // whole point of this page is that an agent's authority is chosen, so this
    // is refused rather than defaulted.
    if (selectedScopes.length === 0) {
      setStatus({
        kind: "error",
        message:
          "Choose what this agent may do. An agent with nothing selected would get unrestricted access.",
      });
      return;
    }
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/org/service-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          scopes: selectedScopes,
          expiresInDays: expiry === "" ? null : Number(expiry),
          // Always explicit, even when empty: omitting this would fall back to
          // contributor on every product (the CI-bot default).
          productGrants: selectedGrants,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not create the agent.",
        });
        return;
      }
      const body = (await res.json()) as {
        account: AgentView;
        key: { key: string };
      };
      setCreated({ name: trimmed, key: body.key.key });
      setAgents((prev) => [body.account, ...prev]);
      setAdding(false);
      resetForm();
    });
  }

  /**
   * Rotate with a fixed lifetime rather than whatever the add form's expiry
   * select happens to hold: the form may be closed, and a credential operation
   * should not silently inherit unrelated UI state. The old key's original
   * lifetime is not recoverable (only its absolute expiry is stored), so the
   * replacement gets a stated default, named on the button.
   */
  function rotate(agent: AgentView) {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/org/service-accounts/${agent.userId}/rotate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expiresInDays: ROTATE_LIFETIME_DAYS }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not rotate the key.",
        });
        return;
      }
      const body = (await res.json()) as {
        key: { id: string; key: string; prefix: string; createdAt: string; expiresAt: string | null };
      };
      setCreated({ name: agent.name, key: body.key.key });
      setAgents((prev) =>
        prev.map((a) =>
          a.userId === agent.userId
            ? {
                ...a,
                key: {
                  id: body.key.id,
                  prefix: body.key.prefix,
                  lastUsedAt: null,
                  expiresAt: body.key.expiresAt,
                  createdAt: body.key.createdAt,
                },
              }
            : a,
        ),
      );
    });
  }

  function revoke(agent: AgentView) {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch(`/api/v1/org/service-accounts/${agent.userId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not revoke the agent.",
        });
        return;
      }
      setAgents((prev) => prev.filter((a) => a.userId !== agent.userId));
    });
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
          <CardDescription>
            Only the workspace owner can manage agent identities.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardDescription>
          Identities for automation that runs unattended: an in-house agent, a
          CI bot, a script. Each is its own workspace member, so its edits are
          attributed to it, it can be granted less than any person has, and
          revoking it leaves your own access untouched. Point an MCP client at{" "}
          <code>/api/mcp</code> with{" "}
          <code>Authorization: Bearer sb_…</code>. For your own coding agent,
          connect over OAuth from the MCP tab instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="space-y-2 rounded-md border border-brand/40 bg-brand/5 p-3">
            <p className="text-sm font-medium">
              Key for &ldquo;{created.name}&rdquo;. Copy it now; you won&rsquo;t
              see it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {created.key}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(created.key)}
              >
                Copy
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreated(null)}
              >
                Done
              </Button>
            </div>
          </div>
        )}

        {/* Add agent: an affordance first, the form only on opt-in (CLAUDE.md). */}
        {adding ? (
          <div className="space-y-5 rounded-md border p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1 space-y-1">
                <label htmlFor="agent-name" className="text-xs text-muted-foreground">
                  Agent name
                </label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Atlas planning agent"
                  maxLength={80}
                  autoFocus
                />
              </div>
              <div className="w-40 space-y-1">
                <label htmlFor="agent-expiry" className="text-xs text-muted-foreground">
                  Key expires
                </label>
                <Select
                  id="agent-expiry"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  {EXPIRY_CHOICES.map((c) => (
                    <option key={c.label} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">What this agent may do</p>
                {SCOPE_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    title={preset.describe}
                    onClick={() => setLevels(preset.levels())}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setLevels({})}
                >
                  Clear
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.title} className="space-y-2">
                    <div>
                      <p className="text-xs font-medium">{group.title}</p>
                      <p className="text-xs text-muted-foreground">{group.hint}</p>
                    </div>
                    <ul className="space-y-1">
                      {group.resources.map(({ resource, label }) => (
                        <li key={resource} className="flex items-center gap-2">
                          <label
                            htmlFor={`scope-${resource}`}
                            className="min-w-0 flex-1 truncate text-xs"
                          >
                            {label}
                          </label>
                          <Select
                            id={`scope-${resource}`}
                            className="h-7 w-32 text-xs"
                            value={levels[resource] ?? "none"}
                            onChange={(e) =>
                              setLevels((prev) => ({
                                ...prev,
                                [resource]: e.target.value as ScopeLevel,
                              }))
                            }
                          >
                            <option value="none">No access</option>
                            <option value="read">Read</option>
                            <option value="write">Read &amp; write</option>
                          </Select>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Which products it may reach</p>
                <p className="text-xs text-muted-foreground">
                  Scopes say what kind of thing an agent may touch; these say
                  whose. An agent with no product granted can read the workspace
                  but write nothing.
                </p>
              </div>
              <ul className="space-y-1">
                {products.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <label
                      htmlFor={`grant-${p.id}`}
                      className="min-w-0 flex-1 truncate text-xs"
                    >
                      {p.name}
                    </label>
                    <Select
                      id={`grant-${p.id}`}
                      className="h-7 w-36 text-xs"
                      value={grants[p.id] ?? "none"}
                      onChange={(e) =>
                        setGrants((prev) => ({
                          ...prev,
                          [p.id]: e.target.value as GrantRole,
                        }))
                      }
                    >
                      <option value="none">No access</option>
                      <option value="viewer">Viewer</option>
                      <option value="contributor">Contributor</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-center gap-2">
              <Button type="button" onClick={create} disabled={pending}>
                Create agent
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  resetForm();
                }}
                disabled={pending}
              >
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                {selectedScopes.length} scope
                {selectedScopes.length === 1 ? "" : "s"} ·{" "}
                {selectedGrants.length} product
                {selectedGrants.length === 1 ? "" : "s"}
              </span>
            </div>
            {status && (
              <p
                role={status.kind === "error" ? "alert" : "status"}
                className={`text-xs ${status.kind === "ok" ? "text-muted-foreground" : "text-destructive"}`}
              >
                {status.message}
              </p>
            )}
          </div>
        ) : agents.length > 0 ? (
          <div className="space-y-2">
            <Button type="button" variant="outline" onClick={openForm}>
              Add agent
            </Button>
            {status && (
              <p role="alert" className="text-xs text-destructive">
                {status.message}
              </p>
            )}
          </div>
        ) : null}

        {agents.length === 0 ? (
          !adding ? (
            <EmptyState
              variant="inline"
              title="No agents yet"
              description="An agent identity lets an in-house agent or CI bot work the board with its own scoped, revocable key, attributed to it rather than to you."
              action={
                <Button size="sm" onClick={openForm}>
                  Add agent
                </Button>
              }
            />
          ) : null
        ) : (
          <ul className="divide-y rounded-md border">
            {agents.map((a) => {
              const granted = a.productGrants
                .map(
                  (g) =>
                    `${products.find((p) => p.id === g.productId)?.name ?? "Unknown product"} (${g.role})`,
                )
                .join(", ");
              return (
                <li
                  key={a.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.key ? (
                        <>
                          <code className="font-mono">{a.key.prefix}…</code>{" "}
                          ·{" "}
                        </>
                      ) : (
                        <>no live key · </>
                      )}
                      {describeScopes(a.scopes)} · last used{" "}
                      <LocalTime
                        iso={a.key?.lastUsedAt ?? null}
                        options={DATE_ONLY}
                        fallback="never"
                      />{" "}
                      · expires{" "}
                      <LocalTime
                        iso={a.key?.expiresAt ?? null}
                        options={DATE_ONLY}
                        fallback="never"
                      />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {granted || "No product access"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title={`Revoke this agent's current key and mint a replacement, valid ${ROTATE_LIFETIME_DAYS} days, with the same scopes.`}
                      onClick={() => rotate(a)}
                      disabled={pending}
                    >
                      Rotate key
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => revoke(a)}
                      disabled={pending}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
