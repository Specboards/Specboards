import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";

import { expect, test } from "@playwright/test";

import {
  getWorkspace,
  outboxCounts,
  resetReleases,
  resetWebhooks,
} from "./helpers/db";

/**
 * Outbound webhooks, end to end: register an endpoint, cause a real event
 * (`release.shipped`), and assert the outbox drainer delivered a correctly
 * signed POST to a local receiver. The app server runs with
 * `SPECBOARD_WEBHOOK_ALLOW_PRIVATE=1` (see playwright.config) so the SSRF guard,
 * which blocks loopback by default, lets it reach the in-test receiver.
 */

type Received = { headers: IncomingHttpHeaders; body: string };

/** Read a header we know is single-valued as a plain string. */
function header(h: IncomingHttpHeaders, name: string): string {
  const v = h[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/** A throwaway HTTP server that records the webhook POSTs it receives. */
async function startReceiver(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: data });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test.describe("webhooks: outbound delivery", () => {
  test("release.shipped is signed and delivered to a registered endpoint", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetWebhooks(ws.id);
    await resetReleases(ws.id);

    const receiver = await startReceiver();
    try {
      // Register an endpoint via the admin API (page.request carries the session).
      const createRes = await page.request.post("/api/v1/webhooks", {
        data: { url: receiver.url, eventTypes: ["release.shipped"], productId: null },
      });
      expect(createRes.status()).toBe(201);
      const { secret } = (await createRes.json()) as { secret: string };
      expect(secret).toMatch(/^whsec_/);

      // Create a release, then ship it -> emits release.shipped through the outbox.
      const relRes = await page.request.post("/api/v1/releases", {
        data: { name: "Hooked release" },
      });
      expect(relRes.status()).toBe(201);
      const { release } = (await relRes.json()) as { release: { id: string } };

      const shipRes = await page.request.patch(`/api/v1/releases/${release.id}`, {
        data: { status: "shipped" },
      });
      expect(shipRes.ok()).toBeTruthy();

      // The drainer delivers within a couple of seconds (opportunistic kick).
      await expect
        .poll(() => receiver.received.length, { timeout: 10_000 })
        .toBeGreaterThan(0);

      const delivery = receiver.received[0]!;
      expect(header(delivery.headers, "x-specboard-event")).toBe("release.shipped");
      expect(header(delivery.headers, "x-specboard-delivery")).toMatch(/^evt_/);

      const envelope = JSON.parse(delivery.body) as {
        type: string;
        data: { name?: string; actor?: { name?: string } | null };
      };
      expect(envelope.type).toBe("release.shipped");
      expect(envelope.data.name).toBe("Hooked release");
      // The actor (the authenticated admin) is attributed on the payload.
      expect(envelope.data.actor?.name).toBeTruthy();

      // The signature verifies against the secret shown once at creation.
      const sig = header(delivery.headers, "x-specboard-signature");
      const t = sig.match(/t=(\d+)/)?.[1];
      const v1 = sig.match(/v1=([a-f0-9]+)/)?.[1];
      expect(t).toBeTruthy();
      const expected = createHmac("sha256", secret)
        .update(`${t}.${delivery.body}`)
        .digest("hex");
      expect(v1).toBe(expected);

      // The event went through the transactional outbox: a row was written in the
      // ship transaction and the relay has since processed it (none left pending).
      await expect
        .poll(() => outboxCounts(ws.id).then((c) => c.total), { timeout: 5_000 })
        .toBeGreaterThan(0);
      const counts = await outboxCounts(ws.id);
      expect(counts.unprocessed).toBe(0);
    } finally {
      await receiver.close();
    }
  });
});
