import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SmtpConfig } from "@/lib/mail/types";

/**
 * The SMTP transport's two jobs beyond sending: refusing a host the policy
 * rejects, and turning a relay's failure into something an operator can act
 * on.
 *
 * The second is the reason the settings screen has a test button at all. Wrong
 * host, wrong port, a TLS mismatch and a relay refusing the sender all look
 * like "it didn't work", and each one points at a different field on the form,
 * so reporting them as one generic error would make the button useless.
 */

let sendMail: ReturnType<typeof vi.fn>;
const close = vi.fn();
let lastOptions: Record<string, unknown> | null = null;

vi.mock("nodemailer", () => ({
  createTransport: (opts: Record<string, unknown>) => {
    lastOptions = opts;
    return { sendMail, close };
  },
}));

const config: SmtpConfig = {
  kind: "smtp",
  from: "Specboards <no-reply@example.com>",
  host: "relay.internal",
  port: 587,
  security: "starttls",
  username: "user",
  password: "pass",
};

const savedTenancy = process.env.SPECBOARDS_MULTI_TENANT;

describe("sendViaSmtp", () => {
  beforeEach(() => {
    sendMail = vi.fn().mockResolvedValue({});
    close.mockClear();
    lastOptions = null;
    // Single-tenant: reaching a relay on a private network is the feature.
    delete process.env.SPECBOARDS_MULTI_TENANT;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedTenancy === undefined) delete process.env.SPECBOARDS_MULTI_TENANT;
    else process.env.SPECBOARDS_MULTI_TENANT = savedTenancy;
  });

  async function send(over: Partial<SmtpConfig> = {}) {
    const { sendViaSmtp } = await import("@/lib/mail/smtp");
    return sendViaSmtp({ ...config, ...over } as SmtpConfig, {
      to: "someone@example.com",
      subject: "Test",
      textBody: "body",
    });
  }

  it("sends through the relay and closes the connection", async () => {
    await send();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      from: config.from,
      to: "someone@example.com",
      subject: "Test",
    });
    // Not merely tidiness: a leaked pool would hold sockets open against the
    // customer's relay for the life of the process.
    expect(close).toHaveBeenCalled();
  });

  it("closes the connection even when the send fails", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("nope"), {}));
    await expect(send()).rejects.toThrow();
    expect(close).toHaveBeenCalled();
  });

  it.each([
    ["EAUTH", undefined, "auth-rejected"],
    [undefined, 535, "auth-rejected"],
    ["ECONNREFUSED", undefined, "connection-refused"],
    ["ETIMEDOUT", undefined, "connection-refused"],
    ["ESOCKET", undefined, "tls"],
    [undefined, 550, "rejected-sender"],
    [undefined, 553, "rejected-sender"],
  ])(
    "reports code %s / status %s as %s",
    async (code, responseCode, kind) => {
      sendMail.mockRejectedValue(
        Object.assign(new Error("relay said no"), { code, responseCode }),
      );
      await expect(send()).rejects.toMatchObject({ kind });
    },
  );

  it("reads a certificate complaint as a TLS problem whatever the code", async () => {
    sendMail.mockRejectedValue(new Error("unable to verify the first certificate"));
    await expect(send()).rejects.toMatchObject({ kind: "tls" });
  });

  it("falls back to unknown rather than guessing", async () => {
    sendMail.mockRejectedValue(new Error("something else entirely"));
    await expect(send()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("refuses a private relay on a multi-tenant deployment", async () => {
    // The policy backstop. A hosted deployment never reads a stored SMTP host
    // in the first place, so this is the second of two locks.
    process.env.SPECBOARDS_MULTI_TENANT = "true";
    vi.resetModules();
    await expect(send({ host: "127.0.0.1" })).rejects.toMatchObject({
      kind: "connection-refused",
    });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("allows a private relay on a single-tenant deployment", async () => {
    // Reaching 10.0.0.25 is not a loophole here, it is the entire feature.
    await send({ host: "10.0.0.25" });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  /**
   * The security setting maps onto two nodemailer flags, not one, and getting
   * it wrong is silent: `secure` means TLS from the first byte (the 465
   * style), while STARTTLS is a plaintext connection that upgrades. Expressing
   * STARTTLS needs `requireTLS` as well, or an upgrade the relay declines
   * falls back to sending in the clear rather than failing.
   */
  it.each([
    ["starttls", { secure: false, requireTLS: true }],
    ["tls", { secure: true, requireTLS: false }],
    ["none", { secure: false, requireTLS: false }],
  ] as const)("maps %s onto the right flags", async (security, expected) => {
    await send({ security });
    expect(lastOptions).toMatchObject(expected);
  });

  it("omits auth entirely for a relay that does not authenticate", async () => {
    await send({ username: null, password: null });
    expect(lastOptions?.auth).toBeUndefined();
  });
});
