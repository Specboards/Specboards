# Webhooks: the delivery contract

Specboards can POST a signed JSON event to a URL you control whenever an item
or a release changes. This page is the contract: the envelope as it is actually
sent, the payload of every event type, how to verify the signature, and what
delivery does and does not guarantee.

It is written for someone building a receiver. You should not need to read our
source to write a correct one. Everything here was checked against
`apps/web/src/lib/webhooks/` rather than carried over from an older design, so
if you find this page and the behaviour disagreeing, the page is the bug.

If you are looking for our own outbound network controls rather than the public
contract, that is a different document:
[`RUNBOOK-webhook-egress-policy.md`](./RUNBOOK-webhook-egress-policy.md).

## Registering an endpoint

Settings > Webhooks. An endpoint is a URL, a set of event types, and optionally
a single product to scope it to.

Your URL must be **`https`** and must resolve to a public address. Private and
reserved ranges are rejected, and the check is repeated at delivery time
against the address the connection is actually pinned to, so a hostname that
later resolves somewhere private stops working rather than being followed. A
self-hosted instance can lift this for endpoints on its own network (see the
runbook above); the hosted service cannot.

**Redirects are not followed.** A `30x` is treated as a failed delivery, not as
a pointer. Register the final URL.

On creation you are shown a **signing secret** once, of the form
`whsec_<random>`. It is stored encrypted and never shown again. Store it
wherever your receiver reads its configuration from; if you lose it, replace the
endpoint.

Scoping an endpoint to a product means it receives events for that product only.
An unscoped endpoint receives events for every product plus workspace-level
events that belong to no product.

## The envelope

Every delivery, of every type, is one JSON object with the same five fields plus
a type-specific `data`:

```json
{
  "id": "evt_9f2c1a7b4e8d4c3fa1b25e6d7c8f9a0b",
  "type": "item.status_changed",
  "occurredAt": "2026-08-31T14:22:05.118Z",
  "workspace": { "id": "c7423ed2-...", "slug": "acme" },
  "product": { "id": "6989aa47-...", "key": "default", "name": "Acme" },
  "data": {
    "specId": "362f82b3-...",
    "title": "Split the store",
    "level": "feature",
    "from": "in_progress",
    "to": "in_review",
    "actor": { "id": "19a5c490-...", "name": "Jonathan Butler" }
  }
}
```

| Field        | Meaning                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | Unique per delivery, prefixed `evt_`. **This is your dedupe key.** Stable across retries of the same delivery.                                          |
| `type`       | One of the event types below.                                                                                                                           |
| `occurredAt` | ISO-8601, when the change was recorded, not when it was delivered. Identical across every endpoint receiving the same change, and unchanged by retries. |
| `workspace`  | Always present.                                                                                                                                         |
| `product`    | The product the change belongs to, or `null` for a workspace-level change such as a portfolio release.                                                  |
| `data`       | Type-specific, described per event below.                                                                                                               |

Treat `data` as open. New fields get added to it, and a receiver that rejects
unknown fields will break on a release that adds one. Likewise, new event
`type`s appear over time; you only receive the types your endpoint subscribes
to, so an unrecognised type means someone changed your subscription.

### `actor`

Every real event's `data` carries an `actor`, the user who caused the change:

```json
"actor": { "id": "19a5c490-...", "name": "Jonathan Butler" }
```

It is `null` when the change had no signed-in user behind it, which is the case
for changes made by a sync or another automated path. Do not assume it is
present. The test delivery described below omits the field entirely, which is
another reason to read it defensively rather than assuming a shape.

## Events

### `item.created`

An item was created.

```json
"data": {
  "specId": "362f82b3-...",
  "title": "Split the store",
  "level": "feature",
  "status": "backlog",
  "actor": { "id": "...", "name": "..." }
}
```

`level` is the hierarchy level key, which is configurable per workspace, so do
not assume it is one of a fixed set.

### `item.status_changed`

An item moved between workflow stages. Only fires when the status actually
changes; an edit that leaves it alone produces nothing.

```json
"data": {
  "specId": "362f82b3-...",
  "title": "Split the store",
  "level": "feature",
  "from": "in_progress",
  "to": "in_review",
  "actor": { "id": "...", "name": "..." }
}
```

`from` and `to` are stage keys from that product's workflow, which is
configurable. `archived` is a stage like any other here.

### `item.deleted`

An item was removed. The payload describes what was removed, since you cannot
look it up afterwards.

```json
"data": {
  "specId": "362f82b3-...",
  "title": "Split the store",
  "level": "feature",
  "actor": { "id": "...", "name": "..." }
}
```

### `release.shipped`

A release moved into `shipped`. Fires on the transition only, so re-saving a
release that is already shipped produces nothing.

```json
"data": {
  "releaseId": "865dd2ce-...",
  "name": "v0.29.3",
  "startDate": "2026-08-31",
  "targetDate": "2026-08-31",
  "itemCount": 12,
  "actor": { "id": "...", "name": "..." }
}
```

`startDate` and `targetDate` are the planned dates and may be `null`. They are
the values the release lands on after the update, not the values it had before.
`itemCount` is how many items were scheduled into it. A portfolio release, which
belongs to no product, arrives with `product: null` at the envelope level.

### The test delivery

"Send test event" in the settings UI sends a real, signed delivery so you can
check your receiver end to end. It is distinguishable:

- `id` is prefixed `evt_test_` rather than `evt_`
- `product` is always `null`
- `data` is `{ "test": true, "message": "This is a test delivery from Specboards." }`

`type` is one of the types your endpoint subscribes to, so your routing runs.
A test delivery is sent once and is not retried.

## Headers

```
Content-Type: application/json
User-Agent: Specboards-Webhooks/1.0
X-Specboards-Event: item.status_changed
X-Specboards-Delivery: evt_9f2c1a7b4e8d4c3fa1b25e6d7c8f9a0b
X-Specboards-Signature: t=1788191725,v1=6f3a...c21
```

`X-Specboards-Event` and `X-Specboards-Delivery` repeat `type` and `id` from the
body, which is convenient for logging and routing before you parse. They are
**not** a substitute for the body: only the body is signed, so authorise on the
verified body, never on a header.

## Verifying the signature

This is the part worth getting exactly right.

- The header is `X-Specboards-Signature: t=<unix-seconds>,v1=<hex>`.
- `v1` is **HMAC-SHA256**, hex encoded, keyed with your endpoint secret.
- The signed string is the timestamp, a literal `.`, then the **raw request
  body**: `"{t}.{rawBody}"`.

The raw body matters. Sign the exact bytes you received, before any JSON parse
and re-serialize, or the digests will not match: key order, whitespace and
number formatting all change under a round trip. Most frameworks need to be told
to keep the raw body.

Compare digests in constant time, and reject a timestamp too far from your own
clock. We allow 300 seconds either side in our own verifier; pick your own
tolerance, but do not skip the check, because it is what makes a captured
delivery unusable later.

### Node

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");

  // timingSafeEqual throws on a length mismatch, so guard first.
  if (expected.length !== parts.v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Wiring it up, with the raw body preserved:

```js
import express from "express";

const app = express();
app.post(
  "/webhooks/specboards",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const raw = req.body.toString("utf8"); // Buffer, not a parsed object
    if (
      !verify(
        process.env.SPECBOARDS_WEBHOOK_SECRET,
        raw,
        req.get("X-Specboards-Signature") ?? "",
      )
    ) {
      return res.sendStatus(401);
    }
    const event = JSON.parse(raw);
    // Acknowledge first, work afterwards. See "Respond fast" below.
    res.sendStatus(204);
    void handle(event);
  },
);
```

### Python

```python
import hashlib, hmac, time

def verify(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(
        kv.split("=", 1) for kv in header.split(",") if "=" in kv
    )
    try:
        t = int(parts["t"].strip())
        v1 = parts["v1"].strip()
    except (KeyError, ValueError):
        return False

    if abs(int(time.time()) - t) > tolerance:
        return False

    expected = hmac.new(
        secret.encode(),
        f"{t}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, v1)
```

## Delivery semantics

**At least once.** A delivery can arrive more than once, and you must be ready
for it. Two things cause it: a retry after we failed to record your success, and
a delivery whose sending process died after your server had already handled the
request, which becomes due again after a 120 second lease expires.

**Dedupe on the envelope `id`.** It is stable across every retry of the same
delivery, so recording the ids you have processed and ignoring repeats is
sufficient. Do not dedupe on `occurredAt` or on the payload contents.

One caveat on that key: a single change fanned out to two endpoints produces a
**different `id` per endpoint**. The id identifies a delivery, not a change. That
is only a problem if you point two endpoints at one receiver and expect it to
collapse them, so do not do that.

**No ordering guarantee.** Deliveries are sent concurrently and retries push
failed ones arbitrarily far into the future, so a status change can easily
arrive after a later one. If order matters to you, order by `occurredAt`
yourself, and treat an event older than the state you already hold as stale
rather than applying it.

**Respond fast.** We wait 5 seconds for your response and then treat the attempt
as failed. Acknowledge with a `2xx` as soon as you have verified and persisted
the raw event, and do the real work afterwards. A receiver that does its
processing inline is the usual cause of duplicate deliveries.

## Retries and failure

Any response outside `2xx`, any redirect, any timeout and any connection error
is a failed attempt.

A failed delivery is retried on this schedule, measured from each failure:

| After attempt | Next attempt in                 |
| ------------- | ------------------------------- |
| 1             | 1 minute                        |
| 2             | 5 minutes                       |
| 3             | 30 minutes                      |
| 4             | 2 hours                         |
| 5             | 6 hours                         |
| 6             | none, the delivery is abandoned |

So a delivery gets up to **six attempts spread over about 8 hours 36 minutes**
before it is given up on. There is no way to replay an abandoned delivery, which
is the reason to acknowledge quickly and reconcile later rather than relying on
retries to cover a long outage.

A URL that fails the address check is **not** retried. It is abandoned
immediately, because retrying cannot make it valid.

**Endpoints that keep failing are switched off.** After 5 consecutive abandoned
deliveries the endpoint is set inactive and stops receiving anything, so a
receiver that has been gone for a week is not still being posted to. A single
successful delivery resets the streak, as does resuming the endpoint by hand in
Settings > Webhooks. Deliveries that were queued while it was off are not
replayed.

## A receiver checklist

- [ ] Read the **raw body** before parsing, and verify the signature against it.
- [ ] Reject on signature failure with a `4xx`, and do not process the body.
- [ ] Check the timestamp is within your tolerance.
- [ ] Dedupe on the envelope `id`.
- [ ] Return `2xx` within 5 seconds; queue the work.
- [ ] Tolerate unknown fields in `data` and a `null` `actor` or `product`.
- [ ] Do not assume ordering; compare `occurredAt` against what you hold.
- [ ] Register the final URL, not one that redirects.
