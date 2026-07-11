import { afterEach, describe, expect, it, vi } from "vitest";

// DNS is mocked per-test; import the module under test after setting up mocks.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { isBlockedIp, resolveValidatedTarget } from "./ssrf";

afterEach(() => {
  lookupMock.mockReset();
  delete process.env.SPECBOARD_WEBHOOK_ALLOW_PRIVATE;
});

describe("isBlockedIp", () => {
  it("allows global unicast addresses", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false); // example.com
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // public v6
  });

  it("blocks loopback, private, CGNAT, and link-local IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "169.254.1.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks the cloud metadata IP", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks IPv6 loopback, ULA, and link-local", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("fd00::1")).toBe(true); // unique-local
    expect(isBlockedIp("fe80::1")).toBe(true); // link-local
    expect(isBlockedIp("ff02::1")).toBe(true); // multicast
  });

  it("blocks IPv4-mapped IPv6 in decimal AND hex notation", () => {
    // Both encode 127.0.0.1; the hex form is what the old decimal-regex missed.
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
    // A mapped metadata address, hex form (169.254.169.254 = a9fe:a9fe).
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
    // A mapped PUBLIC address is fine.
    expect(isBlockedIp("::ffff:93.184.216.34")).toBe(false);
  });

  it("blocks transitional 6to4 / Teredo embeddings", () => {
    expect(isBlockedIp("2002:7f00:1::1")).toBe(true); // 6to4 wrapping 127.0.0.1
    expect(isBlockedIp("2001:0::1")).toBe(true); // Teredo range
  });

  it("blocks garbage that isn't an IP", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("resolveValidatedTarget", () => {
  it("rejects non-https URLs", async () => {
    const r = await resolveValidatedTarget("http://example.com/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    const r = await resolveValidatedTarget("not a url");
    expect(r.ok).toBe(false);
  });

  it("accepts a public hostname and returns its resolved addresses to pin", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const r = await resolveValidatedTarget("https://example.com/hook");
    expect(r.ok).toBe(true);
    expect(r.ok && r.addresses.map((a) => a.address)).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
  });

  it("rejects when a private AAAA record is mixed into public answers", async () => {
    // The classic split-answer bypass: one public A, one private AAAA.
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    const r = await resolveValidatedTarget("https://sneaky.example/hook");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/private or reserved/);
  });

  it("rejects when a hostname resolves to the metadata IP", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const r = await resolveValidatedTarget("https://metadata.example/hook");
    expect(r.ok).toBe(false);
  });

  it("validates a literal public IP host without DNS", async () => {
    const r = await resolveValidatedTarget("https://93.184.216.34/hook");
    expect(r.ok).toBe(true);
    expect(r.ok && r.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a literal private IP host without DNS", async () => {
    const r = await resolveValidatedTarget("https://127.0.0.1/hook");
    expect(r.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects a host that does not resolve", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    const r = await resolveValidatedTarget("https://nope.example/hook");
    expect(r.ok).toBe(false);
  });

  it("allow-private mode skips checks (self-host / e2e) and pins nothing", async () => {
    process.env.SPECBOARD_WEBHOOK_ALLOW_PRIVATE = "1";
    const r = await resolveValidatedTarget("http://localhost:9000/hook");
    expect(r.ok).toBe(true);
    expect(r.ok && r.addresses).toEqual([]);
  });
});
