# Plan: Outbound webhooks (event-driven external calls)

Goal: let a workspace register HTTPS endpoints that receive a signed POST when
certain events happen in the app. First two events:

- `item.status_changed` - a work item moves between workflow stages.
- `release.shipped` - a release is marked shipped.

This doc is the design to react to before any code. It records what the codebase
already gives us, the data + event model, the delivery options (the one real
decision), the signing/security scheme, and a phased build.

## Status (V1 as built, 2026-07-05)

Phase 1 shipped, and the open questions were resolved toward the robust end of
each option (see below), so a few things landed in V1 that the original plan had
deferred:

- **Delivery = durable outbox from day one** (not best-effort). Now a true
  **transactional outbox** (migration 0029, shipped after 0.10.0): each domain
  change writes a generic `outbox_events` row *in the same transaction* as the
  change (the store's mutating methods take an optional event; see
  `lib/store/db.ts`), so an event can never be lost between the commit and a
  separate enqueue. A relay (`lib/webhooks/relay.ts`) claims unprocessed events
  (`FOR UPDATE SKIP LOCKED`, one tx per event) and fans each out into
  `webhook_deliveries`; the in-process drainer (`lib/webhooks/drainer.ts`,
  started in `instrumentation.ts`) then POSTs due rows with a 5s timeout and
  backoff (`1m, 5m, 30m, 2h, 6h`, then failed). The `outbox_events` stream is
  generic on purpose - future consumers (in-app notifications #19, an activity
  feed) can read the same rows.
- **Events (4):** `item.status_changed`, `item.created`, `item.deleted`,
  `release.shipped`.
- **Per-product routing:** `webhook_endpoints.product_id` (nullable; null = all
  products). A workspace-level event (`release.shipped`) reaches only
  null-product endpoints.
- **Actor included** in `data.actor` (`{id, name}`), resolved from the acting
  user; null for unattributable actions.
- **SSRF:** on by default (blocks loopback/private/link-local/metadata; https
  only). `SPECBOARD_WEBHOOK_ALLOW_PRIVATE=1` relaxes it for self-host / e2e.
- **Migration 0028** (`webhook_endpoints` + `webhook_deliveries`, both with the
  `specboard_is_member` RLS policy) applied to **test**; **not yet prod**.
- Both tables and the whole path are covered by `e2e/webhooks.spec.ts` (register
  → ship a release → assert a signed delivery arrives at a local receiver).

**Outbox retention (DONE):** the drainer prunes processed `outbox_events` older
than `SPECBOARD_OUTBOX_RETENTION_DAYS` (default 7; 0 disables) hourly, in bounded
batches. Only processed rows are removed; an old *unprocessed* row (never
relayed) is kept for inspection.

**Phase 2 shipped (2026-07-05, migration 0030):**

- **Delivery-log UI + manual redeliver.** Each endpoint in `Settings → Webhooks`
  expands to its recent deliveries (event, status, attempts, HTTP result, time)
  via `GET /api/v1/webhooks/:id/deliveries`. A per-row "Redeliver" re-queues the
  stored envelope for an immediate resend (`POST
  /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver`); the same envelope id
  and signature are re-sent so consumers dedupe.
- **Endpoint auto-disable after a failure streak.** `webhook_endpoints` gains a
  `consecutive_failures` counter (migration 0030). Each delivery that gives up
  (retry budget exhausted, or a terminal SSRF block) increments it; any success,
  or a manual Resume, resets it. At `WEBHOOK_FAILURE_DISABLE_THRESHOLD` (5) the
  endpoint is set `active = false`, surfaced in the UI as "Auto-disabled" (vs a
  manual "Paused"). Stops a dead endpoint from eating retries forever.

Still to do (Phase 3): more event types, per-`from`/`to` status filtering, and a
notification when an endpoint auto-disables.

## Why this is cheap to hook in (current-state findings)

- **One choke point for status changes.** Every status change (board drag,
  detail-panel edit, raw `/api/v1` PATCH) funnels through
  `apps/web/src/lib/features-service.ts` -> `patchFeature`, which already holds
  both sides of the change in scope: `feature.status` (old) and `patch.status`
  (new). The store write is the line `await store.updateFeature(specId, patch, scope)`.
  That is the natural emission point.
- **Release ship is the same shape.** `features-service.ts` -> `updateRelease`
  delegates to the store; to detect the `planned|in_progress -> shipped` edge we
  read the prior status first (there is no `getRelease`; either add one or
  `listReleases().find`).
- **Prior art to model on.**
  - Inbound GitHub webhook (`apps/web/src/app/api/webhooks/github/route.ts`) -
    HMAC verify, owner-side writes, always-2xx-when-handled.
  - `apps/web/src/lib/crypto.ts` - `encryptSecret` / `decryptSecret` (AES-256-GCM)
    for storing endpoint secrets at rest.
  - `api_keys` table + `Settings -> API keys` page - a workspace-scoped,
    admin-managed, secret-bearing resource. Webhooks copy this shape.
  - RLS is a hand-appended policy per tenant table:
    `CREATE POLICY x_member_all ON t FOR ALL USING (specboard_is_member(workspace_id))`.
- **No background/queue/cron infrastructure.** `fly.toml` is a single web
  process, no `release_command`, no scheduler. So **delivery reliability is the
  one real design decision**, not the plumbing around it.

## Event model

### Envelope (every delivery)

```json
{
  "id": "evt_01J...",                 // ULID, unique per delivery; consumers dedupe on this
  "type": "item.status_changed",
  "occurredAt": "2026-07-05T18:30:00Z",
  "workspace": { "id": "ws_...", "slug": "acme" },
  "product":   { "id": "prd_...", "key": "web", "name": "Web App" },  // null for workspace-level events
  "data": { /* per-type, below */ }
}
```

### `item.status_changed`

```json
{
  "data": {
    "specId": "feat-1234",
    "title": "Bulk-edit statuses from the board",
    "level": "feature",
    "from": "in_progress",
    "to": "in_review",
    "actor": { "id": "usr_...", "name": "Jonathan Butler" }   // null for API-key / system moves
  }
}
```

### `release.shipped`

```json
{
  "data": {
    "releaseId": "rel_...",
    "name": "v0.9",
    "startDate": "2026-06-01",
    "targetDate": "2026-07-15",
    "itemCount": 12,
    "actor": { "id": "usr_...", "name": "Jonathan Butler" }
  }
}
```

Design for extension: `item.created`, `item.assigned`, `idea.promoted`,
`release.created` all slot into the same envelope + taxonomy later. An endpoint
subscribes to a set of `type`s; unknown types are simply never sent.

## Data model

### `webhook_endpoints` (V1) - migration 0028

```sql
CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url           text NOT NULL,                    -- https only, validated on write
  secret        text NOT NULL,                    -- encryptSecret()'d signing key; shown once in the UI
  event_types   text[] NOT NULL DEFAULT '{}',     -- e.g. {item.status_changed, release.shipped}
  description   text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_ws_idx ON webhook_endpoints (workspace_id);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_member_all ON webhook_endpoints
  FOR ALL USING (specboard_is_member(workspace_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO writer;
```

Management is **admin-only** (like releases / API keys). Read/list is fine for
any member; create/edit/delete/reveal-secret is admin.

### `webhook_deliveries` (V2 only)

```sql
CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id      text NOT NULL,          -- the envelope id
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending',  -- pending|delivered|failed
  attempts      int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_status_code int,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';
```

## Emission seam (stable across both delivery models)

A single helper, called from the service layer where old/new are known:

```ts
// lib/events.ts
export async function dispatchEvent(scope, event: DomainEvent): Promise<void> {
  // load active endpoints for scope.workspaceId subscribed to event.type,
  // then hand off to the delivery backend (Phase 1: best-effort; Phase 2: outbox).
  // MUST NOT throw into the caller - a webhook problem never fails the user's write.
}
```

Call sites:

- `patchFeature`, right after `store.updateFeature` succeeds, when
  `patch.status !== undefined && patch.status !== feature.status`.
- `updateRelease`, after the store write, when the status transitions to
  `shipped` from a non-shipped value.

Fault isolation is a hard rule: `dispatchEvent` is wrapped so a delivery error,
a slow endpoint, or a bad URL can never turn a user's status change into a 500.

## Delivery (the decision)

The emission seam is identical either way; only the backend differs, so this is
safe to phase.

### Option A - best-effort in-process (recommended for V1)

On event, load matching endpoints and `fetch` each with the signed body, a ~5s
timeout, and an SSRF guard; log the result. Kicked off after the user's response
so it never adds latency. **No retries, no durability.** The app runs as a
persistent Node server on Fly (not serverless), so a post-response `fetch`
completes normally - but an endpoint that is down at that instant loses the
event, and an in-flight delivery is lost on deploy/crash.

- Fastest path to a working, visible end-to-end slice.
- Weakness: no retry / durability / delivery history.

### Option B - durable outbox + in-process drainer (V2)

Write a `webhook_deliveries` row transactionally with (or immediately after) the
change, then a drainer claims due rows (`FOR UPDATE SKIP LOCKED`), POSTs, and
records `delivered|failed` with backoff. Durable, retriable, and gives a
delivery-log UI + manual redeliver.

- The drainer is a new moving part. With one Fly machine an in-process
  `setInterval` (plus an opportunistic drain on writes) is enough; if we ever
  run >1 instance, `SKIP LOCKED` keeps them from double-sending. A dedicated Fly
  cron machine is the escalation if in-process proves flaky.

### Recommendation

**Phase it: A then B.** Ship best-effort first to validate the payload shapes,
the settings UX, and the two triggers on test; then upgrade the backend to the
outbox behind the same `dispatchEvent` seam without touching the call sites.

## Signing scheme

Stripe-style, HMAC-SHA256 over `"{timestamp}.{rawBody}"` with the endpoint
secret. Headers on every POST:

```
Content-Type: application/json
X-Specboard-Event: item.status_changed
X-Specboard-Delivery: evt_01J...            // = envelope id, for idempotency
X-Specboard-Signature: t=1783200905,v1=<hex hmac>
```

Consumer verification (documented for users):

```
signed = `${t}.${rawBody}`
expected = hmacSHA256(endpointSecret, signed)
valid = timingSafeEqual(expected, v1) && (now - t) < 300   // 5-min replay window
```

## Security

- **SSRF guard (critical - users supply the URL on a hosted multi-tenant app).**
  HTTPS scheme only; reject `localhost`, loopback (`127.0.0.0/8`, `::1`),
  private (`10/8`, `172.16/12`, `192.168/16`, ULA `fc00::/7`), link-local
  (`169.254/16` incl. the `169.254.169.254` cloud metadata IP), and `0.0.0.0`.
  Resolve the host and re-check the resolved IP (guards DNS rebinding); block
  redirects to private targets. Optionally an env allowlist for self-host.
- **Secret at rest:** generated server-side, stored via `encryptSecret`, shown
  to the admin exactly once at creation (rotate = regenerate).
- **Admin-only management**, member-visible list.
- **Caps:** ~5s connect/read timeout, payload size bound, per-endpoint failure
  disable (V2: auto-`active=false` after N consecutive failures with a notice).

## Retry policy (V2)

Exponential backoff, e.g. attempts at `0s, 1m, 5m, 30m, 2h, 6h` (max 6), then
mark `failed`; auto-disable the endpoint after a sustained failure streak.
Manual "redeliver" from the delivery log. `2xx` = delivered; everything else
(incl. timeout) is retryable.

## Scope / modes

- **DB mode** (hosted + self-host-with-Postgres) in V1. **Local file mode**
  (`getStore()` local): gate webhooks off for V1 (they want persistence + a
  running server); revisit if there's demand. Mirrors how some features are
  DB-only.
- Events are workspace-level with an optional `product` in the envelope. Open
  question below: do we also want per-product endpoint routing?

## Open questions

1. **V1 delivery model** - best-effort vs outbox. (Recommendation: best-effort,
   phased.)
2. **Actor in payload** - include the acting user's identity? (Proposed: yes,
   null for API-key/system moves.) Any PII concern for external consumers?
3. **Per-product routing** - can an endpoint subscribe to only one product's
   events, or always the whole workspace? (Proposed: workspace-wide in V1, add a
   `product_id` filter later.)
4. **Status-change granularity** - fire on every transition, or let an endpoint
   filter to specific `from`/`to` stages? (Proposed: every transition in V1;
   filtering later.)
5. **Local file mode** - off in V1, or best-effort there too?

## Phased build

- **Phase 1 (tracer bullet):** `webhook_endpoints` table + migration 0028;
  `Settings -> Webhooks` page (add/list/toggle/delete, secret shown once, "send
  test event"); `dispatchEvent` seam wired at the two call sites; envelope +
  HMAC signing + SSRF guard; **best-effort delivery**. Ships to test end to end.
- **Phase 2 (reliability):** `webhook_deliveries` table + drainer + retry/backoff
  + delivery-log UI with manual redeliver; swap the backend behind
  `dispatchEvent`.
- **Phase 3 (breadth):** more event types, per-product routing, endpoint
  auto-disable + notification.

## Rollout

Each schema step is a migration applied test-first then prod, per
`docs`/the migration runbook. Phase 1 = migration 0028 (`webhook_endpoints`,
with RLS policy + `writer` grant, since it is a new tenant table). Phase 2 =
migration 0029 (`webhook_deliveries`).
