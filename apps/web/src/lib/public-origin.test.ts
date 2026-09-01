import { describe, expect, it } from "vitest";

import { isPubliclyReachable } from "./public-origin";

/**
 * Which setup flow the Repositories page offers turns on this predicate, so a
 * wrong answer is not cosmetic: a false positive sends a self-host operator to
 * the GitHub error page this whole change exists to remove.
 *
 * The cases below are the ones an on-prem deployment actually lands on. The
 * loopback and RFC1918 rows are the reason the manifest flow was unusable for
 * every internal install; the `.internal` and dotless rows are the shapes
 * corporate DNS hands out.
 */
describe("isPubliclyReachable", () => {
  it("accepts an ordinary public origin", () => {
    expect(isPubliclyReachable("https://test.specboards.ai")).toBe(true);
    expect(isPubliclyReachable("https://specboards.example.com:8443")).toBe(true);
    expect(isPubliclyReachable("http://example.com")).toBe(true);
  });

  it("accepts a public IPv4 address", () => {
    expect(isPubliclyReachable("http://8.8.8.8:3000")).toBe(true);
    expect(isPubliclyReachable("https://172.15.0.1")).toBe(true);
    expect(isPubliclyReachable("https://172.32.0.1")).toBe(true);
  });

  it("rejects loopback, which is the default self-host origin", () => {
    expect(isPubliclyReachable("http://localhost:3000")).toBe(false);
    expect(isPubliclyReachable("http://app.localhost:3000")).toBe(false);
    expect(isPubliclyReachable("http://127.0.0.1:3000")).toBe(false);
    expect(isPubliclyReachable("http://127.1.2.3")).toBe(false);
    expect(isPubliclyReachable("http://[::1]:3000")).toBe(false);
    expect(isPubliclyReachable("http://0.0.0.0:3000")).toBe(false);
  });

  it("rejects the RFC1918 private ranges", () => {
    expect(isPubliclyReachable("http://10.0.0.20:3000")).toBe(false);
    expect(isPubliclyReachable("http://192.168.1.50:3000")).toBe(false);
    expect(isPubliclyReachable("http://172.16.0.1")).toBe(false);
    expect(isPubliclyReachable("http://172.31.255.254")).toBe(false);
  });

  it("rejects link-local and carrier-grade NAT", () => {
    expect(isPubliclyReachable("http://169.254.1.1")).toBe(false);
    expect(isPubliclyReachable("http://100.64.0.1")).toBe(false);
    expect(isPubliclyReachable("http://100.127.255.255")).toBe(false);
  });

  it("rejects IPv6 loopback, unique-local and link-local", () => {
    expect(isPubliclyReachable("http://[fd00::1]:3000")).toBe(false);
    expect(isPubliclyReachable("http://[fc00::1]")).toBe(false);
    expect(isPubliclyReachable("http://[fe80::1]")).toBe(false);
  });

  it("rejects internal-only DNS suffixes", () => {
    expect(isPubliclyReachable("https://specboards.corp.internal")).toBe(false);
    expect(isPubliclyReachable("http://specboards.local:3000")).toBe(false);
  });

  it("rejects a dotless intranet hostname", () => {
    expect(isPubliclyReachable("http://specboards:3000")).toBe(false);
    expect(isPubliclyReachable("http://buildserver")).toBe(false);
  });

  it("rejects anything that is not a URL", () => {
    expect(isPubliclyReachable("")).toBe(false);
    expect(isPubliclyReachable("not a url")).toBe(false);
    expect(isPubliclyReachable("specboards.ai")).toBe(false);
  });

  it("ignores case in the hostname", () => {
    expect(isPubliclyReachable("http://LOCALHOST:3000")).toBe(false);
    expect(isPubliclyReachable("https://Specboards.CORP.Internal")).toBe(false);
  });
});
