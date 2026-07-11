import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { fetch as undiciFetch } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { pinnedAgent } from "./sender";

/**
 * Proves the DNS-rebinding defense: a request whose URL hostname would NOT
 * resolve normally still reaches the server, because the pinned agent connects
 * to the pre-validated address instead of re-resolving the host. That is
 * exactly the rebinding case (validation saw one address; the connection is
 * forced to use it) reduced to something testable without a controllable
 * resolver.
 */
describe("pinnedAgent", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("connects to the pinned address, ignoring the URL hostname", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as AddressInfo).port;

    // This hostname is not resolvable (`.invalid` is reserved to never exist),
    // so any success can only come from the pinned 127.0.0.1 lookup.
    const agent = pinnedAgent([{ address: "127.0.0.1", family: 4 }]);
    try {
      const res = await undiciFetch(`http://pinned-host.invalid:${port}/`, {
        dispatcher: agent,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      await agent.close();
    }
  });
});
