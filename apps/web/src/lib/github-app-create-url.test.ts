import { describe, expect, it } from "vitest";

import { githubAppCreateUrl } from "./github-app-create-url";

/**
 * The prefill link is the whole manual setup path compressed into one URL, so
 * what it carries is the contract. Everything asserted here is something that
 * fails *silently* if it drifts: GitHub accepts an app created with a missing
 * permission or a wrong webhook URL and reports nothing, and the operator finds
 * out at install time or at the first push that never arrives.
 */
const ORIGIN = "https://specboards.example.com";

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("githubAppCreateUrl", () => {
  it("points at the organization's own app-creation page", () => {
    const url = githubAppCreateUrl({
      org: "ntxlabs",
      origin: ORIGIN,
      name: "Specboards",
      webhookActive: false,
    });
    expect(url.startsWith(
      "https://github.com/organizations/ntxlabs/settings/apps/new?",
    )).toBe(true);
  });

  it("falls back to the personal-account page when there is no org", () => {
    const url = githubAppCreateUrl({
      org: "  ",
      origin: ORIGIN,
      name: "Specboards",
      webhookActive: false,
    });
    // Not the organizations path: sending someone to /organizations//settings
    // would 404, and an empty org is what an untouched form field holds.
    expect(url.startsWith("https://github.com/settings/apps/new?")).toBe(true);
  });

  it("carries every permission the app cannot work without", () => {
    const p = paramsOf(
      githubAppCreateUrl({
        org: "ntxlabs",
        origin: ORIGIN,
        name: "Specboards",
        webhookActive: false,
      }),
    );
    expect(p.get("administration")).toBe("write");
    expect(p.get("contents")).toBe("write");
    expect(p.get("issues")).toBe("read");
    expect(p.get("metadata")).toBe("read");
    expect(p.get("pull_requests")).toBe("write");
    // The one most often missed by hand. Without it every org install fails at
    // the last step, and nothing on screen says why.
    expect(p.get("members")).toBe("read");
  });

  it("sets the URLs this instance actually serves", () => {
    const p = paramsOf(
      githubAppCreateUrl({
        org: "ntxlabs",
        origin: ORIGIN,
        name: "Specboards",
        webhookActive: false,
      }),
    );
    expect(p.get("url")).toBe(ORIGIN);
    expect(p.get("callback_urls[]")).toBe(
      `${ORIGIN}/api/v1/github/oauth/callback`,
    );
    expect(p.get("setup_url")).toBe(`${ORIGIN}/api/v1/github/setup`);
    // Without this a repository added or removed on GitHub does not come back
    // to us, so the change is invisible until the next scheduled sync.
    expect(p.get("setup_on_update")).toBe("true");
    expect(p.get("public")).toBe("false");
  });

  it("leaves the webhook off, and unaddressed, when GitHub cannot reach us", () => {
    const p = paramsOf(
      githubAppCreateUrl({
        org: "ntxlabs",
        origin: "http://localhost:3000",
        name: "Specboards",
        webhookActive: false,
      }),
    );
    expect(p.get("webhook_active")).toBe("false");
    // Naming a URL GitHub cannot reach would produce an app that looks wired up
    // and fails every delivery.
    expect(p.has("webhook_url")).toBe(false);
    expect(p.getAll("events[]")).toEqual([]);
  });

  it("arms the webhook at the route we serve when GitHub can reach us", () => {
    const p = paramsOf(
      githubAppCreateUrl({
        org: "ntxlabs",
        origin: ORIGIN,
        name: "Specboards",
        webhookActive: true,
      }),
    );
    expect(p.get("webhook_active")).toBe("true");
    // Pinned against app/api/webhooks/github. A wrong path here is accepted by
    // GitHub and 404s on every delivery, silently.
    expect(p.get("webhook_url")).toBe(`${ORIGIN}/api/webhooks/github`);
    expect(p.getAll("events[]")).toEqual(["push", "pull_request", "issues"]);
  });

  it("escapes an org name rather than letting it alter the URL", () => {
    const url = githubAppCreateUrl({
      org: "a/../../evil",
      origin: ORIGIN,
      name: "Specboards",
      webhookActive: false,
    });
    expect(url).not.toContain("/../");
    expect(url.startsWith(
      "https://github.com/organizations/a%2F..%2F..%2Fevil/settings/apps/new?",
    )).toBe(true);
  });
});
