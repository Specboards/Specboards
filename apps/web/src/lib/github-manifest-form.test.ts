import { describe, expect, it } from "vitest";

import { renderManifestForm } from "./github-manifest-form";

/**
 * The regression guard for the seven weeks the self-host GitHub connection was
 * dead.
 *
 * The manifest flow shipped working on 2026-06-14. The nonce-based CSP landed
 * on 2026-07-10 and silently killed it: the page's inline `<script>` had no
 * nonce, so the browser refused it, the hidden field was never filled, and the
 * form never submitted. Nothing failed, because nothing tested this page.
 * `isMultiTenant()` short-circuits the route on hosted, so the only deployment
 * that ran it was the one nobody had a test for.
 *
 * The first test below is the one that would have caught it.
 */
const MANIFEST = {
  name: "Specboards (acme)",
  url: "https://specboards.example.com",
  hook_attributes: { url: "https://specboards.example.com/api/webhooks/github", active: true },
  default_events: ["push"],
};

function render(org = "acme") {
  return renderManifestForm({
    action: "https://github.com/organizations/acme/settings/apps/new",
    nonce: "abc123",
    manifest: MANIFEST,
    org,
  });
}

describe("renderManifestForm", () => {
  it("ships no script tag, so no CSP can stop it working", () => {
    expect(render()).not.toMatch(/<script/i);
  });

  it("carries the manifest in the rendered value, not filled in by script", () => {
    const html = render();
    const value = /name="manifest" value="([^"]*)"/.exec(html)?.[1];
    expect(value, "the hidden manifest field has a value").toBeTruthy();

    // Round-trips: what the browser posts is the manifest we built.
    const decoded = value!
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    expect(JSON.parse(decoded)).toEqual(MANIFEST);
  });

  it("submits to GitHub with the CSRF state on the action", () => {
    expect(render()).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=abc123"',
    );
  });

  it("offers a real submit control rather than relying on an auto-submit", () => {
    expect(render()).toMatch(/<button type="submit"/);
  });

  it("names the organization in the copy when one was given", () => {
    // Scoped to the confirmation sentence: the form's `action` always contains
    // "organizations" for an org target, so a bare substring match proves nothing.
    const sentence = (org: string) =>
      /permissions([\s\S]*?)\.\s*\n?\s*You will come straight back/.exec(render(org))?.[1] ?? "";
    expect(sentence("acme")).toContain("<strong style=\"color:#e6e8eb;\">acme</strong>");
    expect(sentence("")).toBe("");
  });

  it("escapes a hostile org name out of the markup", () => {
    const html = renderManifestForm({
      action: "https://github.com/settings/apps/new",
      nonce: "n",
      manifest: MANIFEST,
      org: '"><img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img");
  });
});
