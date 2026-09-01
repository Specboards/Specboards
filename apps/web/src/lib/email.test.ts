import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isEmailConfigured, sendEmail } from "./email";

const MESSAGE = {
  to: "user@example.test",
  subject: "Test",
  textBody: "hello",
  htmlBody: "<p>hello</p>",
};

function postmarkResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sendEmail", () => {
  const prevToken = process.env.POSTMARK_SERVER_TOKEN;
  const prevFrom = process.env.EMAIL_FROM;

  beforeEach(() => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    process.env.EMAIL_FROM = "Specboards <no-reply@specboards.ai>";
  });

  afterEach(() => {
    process.env.POSTMARK_SERVER_TOKEN = prevToken;
    process.env.EMAIL_FROM = prevFrom;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves on a 200 with ErrorCode 0", async () => {
    const fetchMock = vi.fn(async () =>
      postmarkResponse(200, { ErrorCode: 0, Message: "OK" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when Postmark returns 200 with a non-zero ErrorCode (suppressed recipient)", async () => {
    vi.stubGlobal("fetch", async () =>
      postmarkResponse(200, { ErrorCode: 406, Message: "Inactive recipient" }),
    );
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/406|Inactive recipient/);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () =>
      postmarkResponse(422, {
        ErrorCode: 300,
        Message: "Invalid email request",
      }),
    );
    await expect(sendEmail(MESSAGE)).rejects.toThrow(/422/);
  });

  it("is a no-op (no send) when Postmark creds are unset", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.EMAIL_FROM;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("isEmailConfigured", () => {
  const prevToken = process.env.POSTMARK_SERVER_TOKEN;
  const prevFrom = process.env.EMAIL_FROM;

  afterEach(() => {
    if (prevToken === undefined) delete process.env.POSTMARK_SERVER_TOKEN;
    else process.env.POSTMARK_SERVER_TOKEN = prevToken;
    if (prevFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prevFrom;
  });

  it("is true only when both the token and the sender are set", () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    process.env.EMAIL_FROM = "Specboards <no-reply@example.test>";
    expect(isEmailConfigured()).toBe(true);
  });

  it("is false with a token but no sender", () => {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    delete process.env.EMAIL_FROM;
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false with a sender but no token", () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    process.env.EMAIL_FROM = "Specboards <no-reply@example.test>";
    expect(isEmailConfigured()).toBe(false);
  });

  it("is false when neither is set, which is the default self-host", () => {
    // This is the condition that drops the email-verification requirement:
    // sendEmail would log and discard the link, leaving no way to verify.
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.EMAIL_FROM;
    expect(isEmailConfigured()).toBe(false);
  });
});
