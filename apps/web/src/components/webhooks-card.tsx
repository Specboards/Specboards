"use client";

import { useState, useTransition } from "react";

import { EmptyState } from "@/components/empty-state";
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
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_FAILURE_DISABLE_THRESHOLD,
  type WebhookEventType,
} from "@/lib/webhooks/types";

/** Endpoint shape the settings page serializes down (mirrors the store summary). */
export interface WebhookEndpointView {
  id: string;
  url: string;
  productId: string | null;
  eventTypes: string[];
  description: string | null;
  active: boolean;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

/** One delivery-log row (mirrors the store's `WebhookDeliverySummary`). */
interface WebhookDeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
}

type Status = { kind: "ok" | "error"; message: string } | null;

const ALL_PRODUCTS = "__all__";

const DELIVERY_STATUS_STYLE: Record<string, string> = {
  delivered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  failed: "bg-destructive/15 text-destructive",
};

export function WebhooksCard({
  initialEndpoints,
  products,
}: {
  initialEndpoints: WebhookEndpointView[];
  products: { id: string; name: string }[];
}) {
  const [endpoints, setEndpoints] = useState(initialEndpoints);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [productId, setProductId] = useState<string>(ALL_PRODUCTS);
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set());
  const [status, setStatus] = useState<Status>(null);
  const [created, setCreated] = useState<{
    url: string;
    secret: string;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();
  // Delivery log: which endpoint's log is expanded, and the rows fetched for it.
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<
    Record<string, WebhookDeliveryView[]>
  >({});
  const [loadingLog, setLoadingLog] = useState(false);

  const productName = (id: string | null) =>
    id === null
      ? "All products"
      : (products.find((p) => p.id === id)?.name ?? "Unknown product");

  function toggleEvent(type: WebhookEventType) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function create() {
    if (!url.trim()) {
      setStatus({ kind: "error", message: "Enter an https delivery URL." });
      return;
    }
    if (events.size === 0) {
      setStatus({ kind: "error", message: "Select at least one event." });
      return;
    }
    setStatus(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          description: description.trim() || null,
          productId: productId === ALL_PRODUCTS ? null : productId,
          eventTypes: [...events],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus({
          kind: "error",
          message: body.error ?? "Could not create the endpoint.",
        });
        return;
      }
      const body = (await res.json()) as {
        endpoint: WebhookEndpointView;
        secret: string;
      };
      setCreated({ url: body.endpoint.url, secret: body.secret });
      setEndpoints((prev) => [body.endpoint, ...prev]);
      setUrl("");
      setDescription("");
      setProductId(ALL_PRODUCTS);
      setEvents(new Set());
      setAdding(false);
    });
  }

  function toggleActive(ep: WebhookEndpointView) {
    startTransition(async () => {
      const res = await fetch(`/api/v1/webhooks/${ep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !ep.active }),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: "Could not update the endpoint." });
        return;
      }
      const body = (await res.json()) as { endpoint: WebhookEndpointView };
      setEndpoints((prev) =>
        prev.map((e) => (e.id === ep.id ? body.endpoint : e)),
      );
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await fetch(`/api/v1/webhooks/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        setStatus({ kind: "error", message: "Could not delete the endpoint." });
        return;
      }
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
    });
  }

  function sendTest(id: string) {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch(`/api/v1/webhooks/${id}/test`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        statusCode?: number | null;
        error?: string;
      };
      if (res.ok && body.ok) {
        setStatus({
          kind: "ok",
          message: `Test delivered (HTTP ${body.statusCode}).`,
        });
      } else {
        setStatus({
          kind: "error",
          message: `Test failed: ${body.error ?? "no response"}${
            body.statusCode ? ` (HTTP ${body.statusCode})` : ""
          }.`,
        });
      }
    });
  }

  async function loadDeliveries(id: string) {
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/v1/webhooks/${id}/deliveries`);
      if (!res.ok) {
        setStatus({ kind: "error", message: "Could not load deliveries." });
        return;
      }
      const body = (await res.json()) as { deliveries: WebhookDeliveryView[] };
      setDeliveries((prev) => ({ ...prev, [id]: body.deliveries }));
    } finally {
      setLoadingLog(false);
    }
  }

  function toggleLog(id: string) {
    setStatus(null);
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    setOpenLog(id);
    void loadDeliveries(id);
  }

  function redeliver(endpointId: string, deliveryId: string) {
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/webhooks/${endpointId}/deliveries/${deliveryId}/redeliver`,
        { method: "POST" },
      );
      if (!res.ok) {
        setStatus({ kind: "error", message: "Could not redeliver." });
        return;
      }
      setStatus({ kind: "ok", message: "Queued for redelivery." });
      await loadDeliveries(endpointId);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          Register HTTPS endpoints that receive a signed POST when items and
          releases change. Each delivery is signed with the endpoint&rsquo;s
          secret (HMAC-SHA256 over <code>{"{timestamp}.{body}"}</code>, sent as
          the <code>X-Specboard-Signature</code> header). The secret is shown
          once, at creation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {created && (
          <div className="space-y-2 rounded-md border border-brand/40 bg-brand/5 p-3">
            <p className="text-sm font-medium">
              Endpoint created. Copy the signing secret now; you won&rsquo;t see
              it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {created.secret}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(created.secret)}
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

        {/* Add endpoint: start as an affordance, reveal the form on opt-in
            (see the "add" UX rule in CLAUDE.md). */}
        {adding ? (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1">
              <label htmlFor="wh-url" className="text-xs text-muted-foreground">
                Delivery URL (https)
              </label>
              <Input
                id="wh-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hooks/specboard"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="wh-product"
                  className="text-xs text-muted-foreground"
                >
                  Product
                </label>
                <Select
                  id="wh-product"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  <option value={ALL_PRODUCTS}>All products</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="wh-desc"
                  className="text-xs text-muted-foreground"
                >
                  Description (optional)
                </label>
                <Input
                  id="wh-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Zapier deploy notifier"
                  maxLength={200}
                />
              </div>
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-muted-foreground">Events</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {WEBHOOK_EVENT_TYPES.map((type) => (
                  <label key={type} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={events.has(type)}
                      onChange={() => toggleEvent(type)}
                      className="size-4 rounded border-input"
                    />
                    {WEBHOOK_EVENT_LABELS[type]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center gap-3">
              <Button type="button" onClick={create} disabled={pending}>
                Add endpoint
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
              {status && (
                <p
                  className={`text-xs ${
                    status.kind === "ok"
                      ? "text-muted-foreground"
                      : "text-destructive"
                  }`}
                >
                  {status.message}
                </p>
              )}
            </div>
          </div>
        ) : endpoints.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setStatus(null);
              setAdding(true);
            }}
          >
            Add endpoint
          </Button>
        ) : null}

        {/* List */}
        {endpoints.length === 0 ? (
          !adding ? (
            <EmptyState
              variant="inline"
              title="No endpoints yet"
              description="Webhooks POST a signed payload to your URL when items and releases change - wire up Slack, a deploy notifier, or your own service."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setStatus(null);
                    setAdding(true);
                  }}
                >
                  Add endpoint
                </Button>
              }
            />
          ) : null
        ) : (
          <ul className="divide-y rounded-md border">
            {endpoints.map((ep) => (
              <li key={ep.id} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{ep.url}</p>
                    <p className="text-xs text-muted-foreground">
                      {productName(ep.productId)} ·{" "}
                      {ep.eventTypes
                        .map(
                          (t) =>
                            WEBHOOK_EVENT_LABELS[t as WebhookEventType] ?? t,
                        )
                        .join(", ")}
                      {ep.description ? ` · ${ep.description}` : ""}
                    </p>
                  </div>
                  {(() => {
                    const autoDisabled =
                      !ep.active &&
                      ep.consecutiveFailures >=
                        WEBHOOK_FAILURE_DISABLE_THRESHOLD;
                    return (
                      <span
                        title={
                          autoDisabled
                            ? `Auto-disabled after ${ep.consecutiveFailures} consecutive failures. Resume to re-enable.`
                            : undefined
                        }
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          ep.active
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : autoDisabled
                              ? "bg-destructive/15 text-destructive"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {ep.active
                          ? "Active"
                          : autoDisabled
                            ? "Auto-disabled"
                            : "Paused"}
                      </span>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => sendTest(ep.id)}
                    disabled={pending}
                  >
                    Send test
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleLog(ep.id)}
                  >
                    {openLog === ep.id ? "Hide deliveries" : "Deliveries"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleActive(ep)}
                    disabled={pending}
                  >
                    {ep.active ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(ep.id)}
                    disabled={pending}
                  >
                    Delete
                  </Button>
                </div>
                {openLog === ep.id && (
                  <DeliveryLog
                    rows={deliveries[ep.id]}
                    loading={loadingLog}
                    onRedeliver={(deliveryId) => redeliver(ep.id, deliveryId)}
                    pending={pending}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Recent deliveries for one endpoint, with a per-row redeliver action. */
function DeliveryLog({
  rows,
  loading,
  onRedeliver,
  pending,
}: {
  rows: WebhookDeliveryView[] | undefined;
  loading: boolean;
  onRedeliver: (deliveryId: string) => void;
  pending: boolean;
}) {
  if (rows === undefined) {
    return (
      <p className="pt-1 text-xs text-muted-foreground">
        {loading ? "Loading deliveries…" : "No deliveries loaded."}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="pt-1 text-xs text-muted-foreground">No deliveries yet.</p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border bg-muted/30">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th className="px-2 py-1.5 font-medium">Event</th>
            <th className="px-2 py-1.5 font-medium">Status</th>
            <th className="px-2 py-1.5 font-medium">Attempts</th>
            <th className="px-2 py-1.5 font-medium">Result</th>
            <th className="px-2 py-1.5 font-medium">When</th>
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-b last:border-0 align-top">
              <td className="px-2 py-1.5">
                {WEBHOOK_EVENT_LABELS[d.eventType as WebhookEventType] ??
                  d.eventType}
              </td>
              <td className="px-2 py-1.5">
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    DELIVERY_STATUS_STYLE[d.status] ??
                    "bg-muted text-muted-foreground"
                  }`}
                >
                  {d.status}
                </span>
              </td>
              <td className="px-2 py-1.5 tabular-nums">{d.attempts}</td>
              <td className="min-w-0 max-w-[16rem] px-2 py-1.5">
                {d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : ""}
                {d.lastError ? (
                  <span
                    className="block truncate text-muted-foreground"
                    title={d.lastError}
                  >
                    {d.lastError}
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                {formatWhen(d.createdAt)}
              </td>
              <td className="px-2 py-1.5 text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRedeliver(d.id)}
                  disabled={pending}
                >
                  Redeliver
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
