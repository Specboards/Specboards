import { afterEach, describe, expect, it } from "vitest";

import { canRequireEmailVerification } from "./auth";

/**
 * Email verification is dropped in exactly one configuration: a deployment that
 * declares itself a self-host, is single-tenant, and has no mail transport, so
 * the link it would send could never arrive and the first admin would be locked
 * out of their own instance.
 *
 * This is a truth table rather than a couple of happy-path cases because every
 * one of the three conditions fails open on its own, and the consequence of
 * getting it wrong is silent: nobody sees an error, sign-up simply stops
 * demanding something it should demand.
 */
const KEYS = [
  "SPECBOARDS_SELF_HOST",
  "SPECBOARDS_MULTI_TENANT",
  "POSTMARK_SERVER_TOKEN",
  "EMAIL_FROM",
] as const;

const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function configure(opts: {
  selfHost?: boolean;
  multiTenant?: boolean;
  email?: boolean;
}) {
  for (const k of KEYS) delete process.env[k];
  if (opts.selfHost) process.env.SPECBOARDS_SELF_HOST = "true";
  if (opts.multiTenant) process.env.SPECBOARDS_MULTI_TENANT = "true";
  if (opts.email) {
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    process.env.EMAIL_FROM = "Specboards <no-reply@example.test>";
  }
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("canRequireEmailVerification", () => {
  it("drops the requirement only for a self-host that cannot send email", () => {
    configure({ selfHost: true, email: false });
    expect(canRequireEmailVerification()).toBe(false);
  });

  it("keeps it on a deployment that has not declared itself a self-host", () => {
    // The regression this guards. Single-tenant is the default, so keying off
    // tenancy meant a hosted deployment that lost SPECBOARDS_MULTI_TENANT
    // silently stopped requiring verification.
    configure({ selfHost: false, email: false });
    expect(canRequireEmailVerification()).toBe(true);
  });

  it("keeps it when nothing at all is configured", () => {
    configure({});
    expect(canRequireEmailVerification()).toBe(true);
  });

  it("keeps it on a self-host that can send email", () => {
    configure({ selfHost: true, email: true });
    expect(canRequireEmailVerification()).toBe(true);
  });

  it("keeps it on multi-tenant even if the self-host flag is set by mistake", () => {
    // The opposite mistake: unverified sign-up on a multi-tenant deployment
    // would let anyone claim an address they do not control.
    configure({ selfHost: true, multiTenant: true, email: false });
    expect(canRequireEmailVerification()).toBe(true);
  });

  it("keeps it on multi-tenant with email, the hosted configuration", () => {
    configure({ multiTenant: true, email: true });
    expect(canRequireEmailVerification()).toBe(true);
  });

  it("is not satisfied by half a mail transport", () => {
    // A token with no sender, or a sender with no token, delivers nothing, so
    // it has to count as "no email" rather than as configured.
    configure({ selfHost: true });
    process.env.POSTMARK_SERVER_TOKEN = "test-token";
    expect(canRequireEmailVerification()).toBe(false);

    configure({ selfHost: true });
    process.env.EMAIL_FROM = "Specboards <no-reply@example.test>";
    expect(canRequireEmailVerification()).toBe(false);
  });

  it('treats any value other than "true" as not a self-host', () => {
    for (const value of ["1", "yes", "TRUE", "", "false"]) {
      configure({});
      process.env.SPECBOARDS_SELF_HOST = value;
      expect(canRequireEmailVerification()).toBe(true);
    }
  });
});
