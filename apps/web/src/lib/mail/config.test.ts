import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which transport a deployment resolves to, and the one case that is a
 * security property rather than a preference: a multi-tenant deployment never
 * reads the stored row.
 *
 * The database is mocked rather than real. What is under test is the
 * precedence between three sources, which is decided before any query runs and
 * is exactly the part that would be tedious to provoke against Postgres.
 */

const ENV_KEYS = [
  "EMAIL_FROM",
  "POSTMARK_SERVER_TOKEN",
  "SPECBOARDS_SMTP_HOST",
  "SPECBOARDS_SMTP_PORT",
  "SPECBOARDS_SMTP_SECURITY",
  "SPECBOARDS_SMTP_USERNAME",
  "SPECBOARDS_SMTP_PASSWORD",
  "SPECBOARDS_MULTI_TENANT",
] as const;

let storedRow: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ limit: async () => (storedRow ? [storedRow] : []) }),
    }),
  }),
}));

vi.mock("@/lib/crypto", () => ({
  // The stored values in these fixtures are already plaintext; decryption is
  // covered where it belongs, in the crypto module's own tests.
  decryptSecret: (blob: string) => blob,
  encryptSecret: (value: string) => value,
}));

const saved: Record<string, string | undefined> = {};

describe("resolveMailConfig", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    storedRow = null;
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function resolve() {
    const { resolveMailConfig } = await import("@/lib/mail/config");
    return resolveMailConfig();
  }

  it("is null when nothing is configured anywhere", async () => {
    expect(await resolve()).toBeNull();
  });

  it("needs a sender as well as a token", async () => {
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    expect(await resolve()).toBeNull();
  });

  it("reads Postmark from env", async () => {
    process.env.EMAIL_FROM = "Specboards <no-reply@example.com>";
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    expect(await resolve()).toEqual({
      source: "env",
      config: {
        kind: "postmark",
        from: "Specboards <no-reply@example.com>",
        token: "tok",
      },
    });
  });

  it("prefers SMTP over Postmark when both are in env", async () => {
    // An operator who has set an SMTP host has said what they want; leaving
    // Postmark to win would ignore it and be very hard to see.
    process.env.EMAIL_FROM = "a@example.com";
    process.env.POSTMARK_SERVER_TOKEN = "tok";
    process.env.SPECBOARDS_SMTP_HOST = "smtp.example.com";
    const resolved = await resolve();
    expect(resolved?.config.kind).toBe("smtp");
  });

  it("defaults the SMTP port and security when env gives only a host", async () => {
    process.env.EMAIL_FROM = "a@example.com";
    process.env.SPECBOARDS_SMTP_HOST = "smtp.example.com";
    const resolved = await resolve();
    expect(resolved?.config).toMatchObject({
      kind: "smtp",
      port: 587,
      security: "starttls",
    });
  });

  it("lets stored settings win over env, so the UI can change them", async () => {
    // If env won, an operator who had ever set POSTMARK_SERVER_TOKEN could
    // never move off it without a redeploy, which is the situation this
    // feature exists to end.
    process.env.EMAIL_FROM = "env@example.com";
    process.env.POSTMARK_SERVER_TOKEN = "env-token";
    storedRow = {
      transport: "smtp",
      fromAddress: "stored@example.com",
      smtpHost: "relay.internal",
      smtpPort: 25,
      smtpSecurity: "none",
      smtpUsername: null,
      smtpPassword: null,
      postmarkToken: null,
    };
    expect(await resolve()).toEqual({
      source: "settings",
      config: {
        kind: "smtp",
        from: "stored@example.com",
        host: "relay.internal",
        port: 25,
        security: "none",
        username: null,
        password: null,
      },
    });
  });

  it("never reads the stored row on a multi-tenant deployment", async () => {
    // The security property. Mail transport is the credential every
    // transactional message leaves through, so a stored row that a tenant
    // could have written must not be reachable where tenants exist.
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    process.env.EMAIL_FROM = "env@example.com";
    process.env.POSTMARK_SERVER_TOKEN = "env-token";
    storedRow = {
      transport: "smtp",
      fromAddress: "attacker@example.com",
      smtpHost: "relay.attacker.test",
      smtpPort: 25,
      smtpSecurity: "none",
      smtpUsername: null,
      smtpPassword: null,
      postmarkToken: null,
    };
    const resolved = await resolve();
    expect(resolved?.source).toBe("env");
    expect(resolved?.config).toMatchObject({ kind: "postmark", from: "env@example.com" });
  });

  it("falls back to env when the stored row names a transport it does not know", async () => {
    // The column is text so a newer version can add a transport. An older one
    // reading that row should degrade to env rather than throw on every send.
    process.env.EMAIL_FROM = "env@example.com";
    process.env.POSTMARK_SERVER_TOKEN = "env-token";
    storedRow = { transport: "carrier-pigeon", fromAddress: "x@example.com" };
    expect((await resolve())?.source).toBe("env");
  });

  it("falls back to env when the stored row is incomplete", async () => {
    process.env.EMAIL_FROM = "env@example.com";
    process.env.POSTMARK_SERVER_TOKEN = "env-token";
    storedRow = {
      transport: "smtp",
      fromAddress: "x@example.com",
      smtpHost: null,
      smtpPort: null,
      smtpSecurity: null,
    };
    expect((await resolve())?.source).toBe("env");
  });
});
