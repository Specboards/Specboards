import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pinnedAgent } from "@/lib/egress";

/**
 * The rebinding defence over TLS, which is the transport every caller actually
 * uses: `resolveTarget` refuses plain http unless a deployment has opted into
 * reaching its own network, so real webhook and hosted-model traffic is https.
 *
 * There was already a proof of pinning over http, in `webhooks/sender.test.ts`,
 * and it is not a substitute. undici builds the two transports differently: the
 * plaintext path hands our options to `net.connect`, while the https path hands
 * them to `tls.connect`, and only the second one is on the route we ship. A
 * change to how `connect` options are threaded could leave the http proof green
 * while https quietly re-resolved the hostname, which is the failure this file
 * exists to catch. It was written when undici went 6 -> 8 for exactly that
 * reason.
 *
 * The certificate names the URL's hostname rather than the address dialled, so
 * a pass also demonstrates the second half of the contract: the connection goes
 * to the pinned address, but SNI and certificate verification still use the
 * hostname the caller asked for. If pinning were achieved by rewriting the URL
 * to the IP, this test would fail on hostname verification.
 */

const dir = mkdtempSync(join(tmpdir(), "sb-egress-"));
const certPath = join(dir, "cert.pem");
const keyPath = join(dir, "key.pem");

/** `.invalid` is reserved never to resolve, so reaching it proves the pinning. */
const HOST = "pinned-host.invalid";

/** Whether this machine can issue a test certificate at all. */
let haveOpenssl = false;
try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes",
      "-subj", `/CN=${HOST}`,
      "-addext", `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: "ignore" },
  );
  haveOpenssl = true;
} catch {
  haveOpenssl = false;
}

describe.skipIf(!haveOpenssl)("pinnedAgent over https", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer(
      { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects to the pinned address while verifying the URL hostname", async () => {
    const agent = pinnedAgent([{ address: "127.0.0.1", family: 4 }], 5_000, {
      ca: [readFileSync(certPath, "utf8")],
    });
    try {
      const res = await undiciFetch(`https://${HOST}:${port}/`, { dispatcher: agent });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      await agent.close();
    }
  });

  it("still verifies the certificate, so the ca option cannot be a no-op", async () => {
    // The mirror of the case above. If a request succeeded with no authority
    // configured, `tls.ca` would not be reaching OpenSSL at all and the private
    // CA support would be theatre, so the positive test above would prove
    // nothing about verification.
    //
    // Asserting the specific cause matters more than it looks. The obvious
    // `rejects.toThrow()` would also be satisfied by the request failing to
    // resolve `.invalid` at all, which is the exact broken-pinning state this
    // file is meant to detect: the negative test would go green precisely when
    // the positive one started failing for real.
    const agent = pinnedAgent([{ address: "127.0.0.1", family: 4 }], 5_000);
    try {
      const err = await undiciFetch(`https://${HOST}:${port}/`, {
        dispatcher: agent,
      }).then(
        () => null,
        (e: unknown) => e as { cause?: { code?: string } },
      );
      expect(err?.cause?.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    } finally {
      await agent.close();
    }
  });
});
