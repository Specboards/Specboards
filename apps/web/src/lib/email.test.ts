import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail } from "./email";

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
      postmarkResponse(422, { ErrorCode: 300, Message: "Invalid email request" }),
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
