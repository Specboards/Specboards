import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SetupGitHubCard } from "./github-app-setup";

// The form refreshes the route after saving, and `useRouter` needs a mounted
// app router. Mocked the same way the other component tests here do it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/**
 * Handing over the GitHub App's private key.
 *
 * The form used to offer one way to do this: open the .pem GitHub downloaded,
 * select all of it, and paste it into a textarea. Reported from a real
 * self-host setup as the awkward step it is, and it is the step where a
 * partial selection produces a key that looks present and does not work.
 *
 * So the file is the default path and pasting is the fallback. What is pinned
 * here is that the upload exists, that the paste box is not sitting open, and
 * that the field never renders a key back into the page.
 */

/**
 * A non-public origin, which is what a localhost self-host is. That is the
 * case where GitHub refuses to create the App itself, so the manual form is
 * rendered inline rather than behind a disclosure.
 */
const render = () =>
  renderToStaticMarkup(
    <SetupGitHubCard origin="http://localhost:3000" originIsPublic={false} />,
  );

describe("the manual GitHub App form", () => {
  it("offers a file chooser for the .pem", () => {
    const html = render();
    expect(html).toMatch(/type="file"/);
    expect(html).toMatch(/\.pem/);
  });

  it("does not sit with the paste box open", () => {
    // The fallback, revealed on request. An always-open textarea beside a file
    // chooser is two answers to one question.
    const html = render();
    expect(html).not.toMatch(/-----BEGIN RSA PRIVATE KEY-----/);
    expect(html).toMatch(/Paste it instead/);
  });

  it("says the key is read in the browser and never sent back", () => {
    // The sentence that makes uploading a private key to a settings form feel
    // like a considered act rather than a leap.
    expect(render()).toMatch(/read in your browser/i);
  });

  it("tells a non-public origin it must create the app by hand", () => {
    // Unrelated to the key, and the reason this form is reachable at all.
    expect(render()).toMatch(/localhost:3000/);
  });
});
