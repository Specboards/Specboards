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

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

type Status = { kind: "ok" | "error"; message: string } | null;

/**
 * Date-only options, hoisted so the value is a stable identity rather than a
 * fresh object each render. See {@link LocalTime} for why a timestamp is a
 * component and not a string: formatting one during SSR breaks hydration and
 * takes this card's buttons with it.
 */
const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

export function ApiKeysCard({ initialKeys }: { initialKeys: ApiKeyView[] }) {
  const [keys, setKeys] = useState<ApiKeyView[]>(initialKeys);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(
    null,
  );
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Give the key a name first." });
      return;
    }
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // A personal key carries its owner's own authority, and this card has
        // no scope picker, so full access is the intended product behaviour
        // rather than an oversight. It is stated as `["*"]` because the
        // endpoint no longer accepts an absent list: on a credential-minting
        // route, saying nothing should not be the broadest thing you can say.
        body: JSON.stringify({ name: trimmed, scopes: ["*"] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not create the key.",
        });
        return;
      }
      const body = (await res.json()) as {
        key: {
          id: string;
          key: string;
          name: string;
          prefix: string;
          createdAt: string;
          expiresAt: string | null;
        };
      };
      setCreated({ name: body.key.name, key: body.key.key });
      setKeys((prev) => [
        {
          id: body.key.id,
          name: body.key.name,
          prefix: body.key.prefix,
          lastUsedAt: null,
          expiresAt: body.key.expiresAt,
          createdAt: body.key.createdAt,
        },
        ...prev,
      ]);
      setName("");
      setAdding(false);
    });
  }

  function revoke(id: string) {
    startTransition(async () => {
      const res = await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        setStatus({ kind: "error", message: "Could not revoke the key." });
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          Personal keys for the Specboards CLI and programmatic access. Each key
          acts as you and inherits your workspace role. The full key is shown
          once, at creation. Send it as the <code>x-api-key</code> header.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="space-y-2 rounded-md border border-brand/40 bg-brand/5 p-3">
            <p className="text-sm font-medium">
              New key &ldquo;{created.name}&rdquo; created. Copy it now; you
              won&rsquo;t see it again.
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

        {/* Add API key: start as an affordance, reveal the form on opt-in
            (see the "add" UX rule in CLAUDE.md). */}
        {adding ? (
          <div className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label
                  htmlFor="api-key-name"
                  className="text-xs text-muted-foreground"
                >
                  New key name
                </label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. laptop CLI"
                  maxLength={80}
                  autoFocus
                />
              </div>
              <Button type="button" onClick={create} disabled={pending}>
                Create key
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setStatus(null);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
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
        ) : keys.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setStatus(null);
              setAdding(true);
            }}
          >
            Add API key
          </Button>
        ) : null}

        {keys.length === 0 ? (
          !adding ? (
            <EmptyState
              variant="inline"
              title="No API keys yet"
              description="API keys let the Specboards CLI and scripts act as you, with your workspace role. The full key is shown once, at creation."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setStatus(null);
                    setAdding(true);
                  }}
                >
                  Add API key
                </Button>
              }
            />
          ) : null
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{k.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{k.prefix}…</code> · created{" "}
                    <LocalTime iso={k.createdAt} options={DATE_ONLY} fallback="never" />{" "}
                    · last used{" "}
                    <LocalTime iso={k.lastUsedAt} options={DATE_ONLY} fallback="never" />
                    {k.expiresAt ? (
                      <>
                        {" · expires "}
                        <LocalTime
                          iso={k.expiresAt}
                          options={DATE_ONLY}
                          fallback="never"
                        />
                      </>
                    ) : null}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => revoke(k.id)}
                  disabled={pending}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
