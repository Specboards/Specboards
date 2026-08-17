import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { assertModelTlsConfig, modelCaBundle, resetModelCaCache } from "./tls";

/**
 * Trusting an internal certificate authority for the model endpoint.
 *
 * The properties worth pinning are the two that make this safe to have at all:
 * trust is *added* rather than replaced, so configuring an internal CA cannot
 * quietly break a workspace pointed at a public provider; and a
 * misconfiguration is loud, because the alternative is an operator staring at
 * "could not reach the model endpoint" with no way to tell a bad path from a
 * firewall.
 */

// Not a real certificate. Nothing here parses one: the module's job is to find
// the bytes and hand them to Node, and a valid chain would test OpenSSL.
const PEM =
  "-----BEGIN CERTIFICATE-----\nMIIByTestNotARealCertificate\n-----END CERTIFICATE-----\n";

const dir = mkdtempSync(join(tmpdir(), "sb-model-ca-"));

function writePem(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  delete process.env.SPECBOARDS_MODEL_CA_CERT;
  resetModelCaCache();
});

describe("with nothing configured", () => {
  it("leaves Node's defaults alone", () => {
    // undefined, not an empty array: passing `ca: []` to TLS would trust
    // nothing at all, which is the opposite of the intended no-op.
    resetModelCaCache();
    expect(modelCaBundle()).toBeUndefined();
  });
});

describe("with a certificate configured", () => {
  it("accepts PEM text inline", () => {
    // Trimmed, because a secret pasted into a platform's UI routinely arrives
    // with whitespace around it and OpenSSL is not forgiving about that.
    process.env.SPECBOARDS_MODEL_CA_CERT = `  ${PEM}  `;
    resetModelCaCache();
    expect(modelCaBundle()).toContain(PEM.trim());
  });

  it("accepts a path to a PEM file", () => {
    process.env.SPECBOARDS_MODEL_CA_CERT = writePem("ca.pem", PEM);
    resetModelCaCache();
    expect(modelCaBundle()).toContain(PEM);
  });

  it("keeps the public roots as well", () => {
    // The failure this prevents: an operator adds an internal CA for one
    // endpoint and every hosted provider stops verifying, because passing `ca`
    // replaces Node's store rather than extending it.
    process.env.SPECBOARDS_MODEL_CA_CERT = PEM;
    resetModelCaCache();
    const bundle = modelCaBundle()!;
    expect(bundle.length).toBe(rootCertificates.length + 1);
    expect(bundle[0]).toBe(rootCertificates[0]);
  });

  it("reads it once rather than on every call", () => {
    // This sits on the inference path, so it must not touch disk per request.
    process.env.SPECBOARDS_MODEL_CA_CERT = writePem("cached.pem", PEM);
    resetModelCaCache();
    expect(modelCaBundle()).toContain(PEM);
    writeFileSync(join(dir, "cached.pem"), `${PEM}changed`, "utf8");
    expect(modelCaBundle()).toContain(PEM);
  });
});

describe("with it misconfigured", () => {
  it("says the path could not be read, and what was expected", () => {
    process.env.SPECBOARDS_MODEL_CA_CERT = join(dir, "does-not-exist.pem");
    resetModelCaCache();
    expect(() => modelCaBundle()).toThrow(/neither PEM text nor a readable file/);
  });

  it("rejects a readable file that holds no certificate", () => {
    // Pointing at the private key instead of the certificate is the common
    // slip, and silently trusting nothing would look like a network problem.
    process.env.SPECBOARDS_MODEL_CA_CERT = writePem("key.pem", "not a certificate");
    resetModelCaCache();
    expect(() => modelCaBundle()).toThrow(/contains no certificate/);
  });

  it("fails the boot rather than the first model call", () => {
    process.env.SPECBOARDS_MODEL_CA_CERT = join(dir, "typo.pem");
    expect(() => assertModelTlsConfig()).toThrow(/SPECBOARDS_MODEL_CA_CERT/);
  });

  it("boots quietly when nothing is configured", () => {
    expect(() => assertModelTlsConfig()).not.toThrow();
  });
});
