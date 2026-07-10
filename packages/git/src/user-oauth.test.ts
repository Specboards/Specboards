import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exchangeGithubUserCode,
  getGithubUserLogin,
  verifyInstallationOwnership,
} from "./user-oauth.js";

const CREDS = { clientId: "Iv1.abc", clientSecret: "shhh" };

/** Stub global fetch with a URL-keyed table of responses. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!match) throw new Error(`unexpected fetch: ${url}`);
      const { status = 200, body } = match[1];
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exchangeGithubUserCode", () => {
  it("returns the access token and sends the client credentials", async () => {
    const calls = stubFetch({
      "https://github.com/login/oauth/access_token": { body: { access_token: "gho_tok" } },
    });
    const token = await exchangeGithubUserCode(CREDS, "code123", "https://app.test/cb");
    expect(token).toBe("gho_tok");
    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent).toMatchObject({
      client_id: CREDS.clientId,
      client_secret: CREDS.clientSecret,
      code: "code123",
      redirect_uri: "https://app.test/cb",
    });
  });

  it("throws when GitHub rejects the code (no token in the response)", async () => {
    stubFetch({
      "https://github.com/login/oauth/access_token": {
        body: { error: "bad_verification_code" },
      },
    });
    await expect(
      exchangeGithubUserCode(CREDS, "expired", "https://app.test/cb"),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("throws on a non-2xx exchange response", async () => {
    stubFetch({
      "https://github.com/login/oauth/access_token": { status: 500, body: {} },
    });
    await expect(
      exchangeGithubUserCode(CREDS, "code", "https://app.test/cb"),
    ).rejects.toThrow(/500/);
  });
});

describe("getGithubUserLogin", () => {
  it("returns the login and authenticates with the token", async () => {
    const calls = stubFetch({
      "https://api.github.com/user": { body: { login: "octocat" } },
    });
    await expect(getGithubUserLogin("tok")).resolves.toBe("octocat");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("throws when the response has no login", async () => {
    stubFetch({ "https://api.github.com/user": { body: {} } });
    await expect(getGithubUserLogin("tok")).rejects.toThrow(/no login/);
  });
});

describe("verifyInstallationOwnership", () => {
  it("accepts a personal installation owned by the same user", async () => {
    stubFetch({ "https://api.github.com/user": { body: { login: "OctoCat" } } });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "octocat",
      type: "User",
    });
    expect(verdict).toEqual({ ok: true, viewerLogin: "OctoCat" });
  });

  it("rejects a personal installation owned by someone else", async () => {
    stubFetch({ "https://api.github.com/user": { body: { login: "attacker" } } });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "victim",
      type: "User",
    });
    expect(verdict.ok).toBe(false);
  });

  it("accepts an active org admin", async () => {
    stubFetch({
      "https://api.github.com/user/memberships/orgs/acme": {
        body: { state: "active", role: "admin" },
      },
      "https://api.github.com/user": { body: { login: "octocat" } },
    });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "acme",
      type: "Organization",
    });
    expect(verdict.ok).toBe(true);
  });

  it("rejects a plain org member", async () => {
    stubFetch({
      "https://api.github.com/user/memberships/orgs/acme": {
        body: { state: "active", role: "member" },
      },
      "https://api.github.com/user": { body: { login: "octocat" } },
    });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "acme",
      type: "Organization",
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a pending admin invitation", async () => {
    stubFetch({
      "https://api.github.com/user/memberships/orgs/acme": {
        body: { state: "pending", role: "admin" },
      },
      "https://api.github.com/user": { body: { login: "octocat" } },
    });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "acme",
      type: "Organization",
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a non-member (404 membership lookup) instead of throwing", async () => {
    stubFetch({
      "https://api.github.com/user/memberships/orgs/victim-org": {
        status: 404,
        body: { message: "Not Found" },
      },
      "https://api.github.com/user": { body: { login: "attacker" } },
    });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "victim-org",
      type: "Organization",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not a member/);
  });

  it("rejects unknown account types", async () => {
    stubFetch({ "https://api.github.com/user": { body: { login: "octocat" } } });
    const verdict = await verifyInstallationOwnership("tok", {
      login: "big-corp",
      type: "Enterprise",
    });
    expect(verdict.ok).toBe(false);
  });

  it("throws (fails closed) on an unexpected membership API error", async () => {
    stubFetch({
      "https://api.github.com/user/memberships/orgs/acme": { status: 500, body: {} },
      "https://api.github.com/user": { body: { login: "octocat" } },
    });
    await expect(
      verifyInstallationOwnership("tok", { login: "acme", type: "Organization" }),
    ).rejects.toThrow(/500/);
  });
});
