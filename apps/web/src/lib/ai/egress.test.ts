import { afterEach, describe, expect, it, vi } from "vitest";

// DNS is mocked per-test; import the module under test after the mock is set up.
const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  allowPrivateModelTargets,
  assertModelEgressPolicy,
  resolveModelTarget,
} from "./egress";

/**
 * The model endpoint's egress policy, which is where this epic's stated tension
 * gets resolved: the guard exists to stop a customer-supplied URL reaching the
 * internal network, and the on-prem requirement is that it reach exactly that.
 *
 * The resolution is by deployment shape, so these cases are mostly about which
 * deployment is allowed to opt in, and proving that a hosted one cannot however
 * the environment is set.
 */

afterEach(() => {
  lookupMock.mockReset();
  delete process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE;
  delete process.env.SPECBOARDS_MULTI_TENANT;
  delete process.env.SPECBOARDS_WEBHOOK_ALLOW_PRIVATE;
  vi.restoreAllMocks();
});

describe("allowPrivateModelTargets", () => {
  it("is off by default", () => {
    expect(allowPrivateModelTargets()).toBe(false);
  });

  it("opts in on a single-tenant deployment", () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    expect(allowPrivateModelTargets()).toBe(true);
  });

  it("is ignored outright on a multi-tenant deployment", () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    // Not merely discouraged: a boot guard cannot help against an env var set
    // on a process that is already running, so the request-time check has to
    // refuse on its own.
    expect(allowPrivateModelTargets()).toBe(false);
  });

  it("is not turned on by the webhook flag", () => {
    // Separate switches on purpose: allowing a self-hosted model must not
    // silently re-point webhook deliveries at the internal network.
    process.env.SPECBOARDS_WEBHOOK_ALLOW_PRIVATE = "1";
    expect(allowPrivateModelTargets()).toBe(false);
  });
});

describe("assertModelEgressPolicy", () => {
  it("says nothing when the flag is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertModelEgressPolicy()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses to boot a multi-tenant deployment with the flag set", () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    expect(() => assertModelEgressPolicy()).toThrow(/Refusing to start/);
  });

  it("warns but allows a self-hosted deployment", () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertModelEgressPolicy()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("resolveModelTarget", () => {
  it("rejects a non-URL", async () => {
    const r = await resolveModelTarget("not a url");
    expect(r).toEqual({ ok: false, reason: "Not a valid URL." });
  });

  it("rejects plain http by default, and says how to allow it", async () => {
    const r = await resolveModelTarget("http://api.example.com/v1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/SPECBOARDS_MODEL_ALLOW_PRIVATE/);
  });

  it("rejects a literal private address", async () => {
    const r = await resolveModelTarget("https://10.0.0.4/v1");
    expect(r).toEqual({
      ok: false,
      reason: "URL points at a private or reserved address.",
    });
  });

  it("rejects the cloud metadata address", async () => {
    const r = await resolveModelTarget("https://169.254.169.254/v1");
    expect(r.ok).toBe(false);
  });

  it("rejects a hostname that resolves somewhere private", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const r = await resolveModelTarget("https://inference.example.com/v1");
    expect(r).toEqual({
      ok: false,
      reason: "Host resolves to a private or reserved address.",
    });
  });

  it("rejects when only ONE of several answers is private", async () => {
    // A split-horizon answer is still an answer we must not connect to.
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    const r = await resolveModelTarget("https://inference.example.com/v1");
    expect(r.ok).toBe(false);
  });

  it("returns the validated addresses for a public host, so the call can pin", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const r = await resolveModelTarget("https://api.openai.com/v1");
    expect(r).toEqual({
      ok: true,
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("allows a private http endpoint when a self-host opts in", async () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    const r = await resolveModelTarget("http://localhost:11434/v1");
    // No addresses: allow-private mode connects normally rather than pinning.
    expect(r).toEqual({ ok: true, addresses: [] });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("still refuses that same endpoint on a hosted deployment", async () => {
    process.env.SPECBOARDS_MODEL_ALLOW_PRIVATE = "1";
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    const r = await resolveModelTarget("http://localhost:11434/v1");
    expect(r.ok).toBe(false);
  });
});
