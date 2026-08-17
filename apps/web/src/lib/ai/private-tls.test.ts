import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createOpenAiCompatibleClient } from "./openai-compatible";
import { resetModelCaCache } from "./tls";

/**
 * The on-prem TLS case, end to end against a real HTTPS server presenting a
 * real self-signed certificate.
 *
 * This is the thing most likely to break first in an air-gapped deployment and
 * the least likely to be caught by anything else: inference sits behind a
 * certificate from the customer's internal authority, Node trusts neither that
 * nor a self-signed one, and the failure arrives as "could not reach the model
 * endpoint", which reads as a network problem. A unit test asserting that a
 * `ca` option is passed along would not catch getting the option shape wrong.
 * OpenSSL has to actually accept it.
 *
 * The negative case matters as much as the positive one. If the request
 * succeeded without the certificate configured, verification would be off
 * somewhere and the whole feature would be theatre.
 */

const dir = mkdtempSync(join(tmpdir(), "sb-tls-"));
const certPath = join(dir, "cert.pem");
const keyPath = join(dir, "key.pem");

/** Whether this machine can issue a test certificate at all. */
let haveOpenssl = false;
try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes",
      "-subj", "/CN=specboards-test",
      // The URL below dials 127.0.0.1, so the certificate has to name it or
      // verification fails on the hostname rather than on the authority, which
      // would be a different bug passing itself off as this one.
      "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  haveOpenssl = true;
} catch {
  haveOpenssl = false;
}

describe.skipIf(!haveOpenssl)("a model endpoint behind a self-signed certificate", () => {
  let server: Server;
  let baseUrl = "";

  const REPLY = JSON.stringify({
    model: "local-model",
    choices: [{ message: { role: "assistant", content: "ready" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });

  beforeAll(async () => {
    // Private addresses and plain http are refused unless a deployment has
    // opted in, which is exactly the configuration an on-prem install runs.
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    delete process.env.SPECBOARDS_MULTI_TENANT;

    server = createServer(
      { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(REPLY);
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    delete process.env.SPECBOARDS_MODEL_CA_CERT;
    resetModelCaCache();
  });

  const call = () =>
    createOpenAiCompatibleClient({
      baseUrl,
      model: "local-model",
      apiKey: null,
    }).complete({ messages: [{ role: "user", content: "hi" }] });

  it("is refused when the certificate is not trusted", () => {
    resetModelCaCache();
    return call().then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.kind).toBe("unreachable");
      // undici's own message here is the bare string "fetch failed", which
      // sends an operator to look at firewalls. The message has to say it was
      // the certificate and name the variable that fixes it.
      expect(outcome.error.message).toMatch(/self-signed certificate/i);
      expect(outcome.error.message).toContain("SPECBOARDS_MODEL_CA_CERT");
    });
  });

  it("succeeds once the certificate is configured as the authority", async () => {
    process.env.SPECBOARDS_MODEL_CA_CERT = certPath;
    resetModelCaCache();

    const outcome = await call();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("ready");
  });

  it("accepts the certificate inline as well as by path", async () => {
    // Some platforms make a secret easier to set than a file to mount.
    process.env.SPECBOARDS_MODEL_CA_CERT = readFileSync(certPath, "utf8");
    resetModelCaCache();

    const outcome = await call();
    expect(outcome.ok).toBe(true);
  });
});
