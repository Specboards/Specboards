import { describe, expect, it } from "vitest";

import {
  visibleSettingsSections,
  type SettingsViewer,
} from "@/lib/settings-sections";

/**
 * The interesting cases are the two ends and the one in the middle: an owner
 * loses nothing, a plain member is offered only what they can act on, and a
 * product admin keeps the two screens that exist for managing their product.
 */

const owner: SettingsViewer = {
  isOwner: true,
  managesAnyProduct: true,
  canConfigureMail: true,
};
const member: SettingsViewer = {
  isOwner: false,
  managesAnyProduct: false,
  canConfigureMail: true,
};

const labels = (v: SettingsViewer) =>
  visibleSettingsSections(v).map((s) => s.label);

describe("settings sections", () => {
  it("offers the owner of a self-hosted deployment everything", () => {
    expect(labels(owner)).toEqual([
      "Profile",
      "Notifications",
      "Email",
      "Company & Team",
      "Products",
      "Cards",
      "Tags",
      "Ideas",
      "Hierarchy",
      "Agents",
      "Branding",
      "Integrations",
    ]);
  });

  it("offers a member only what they can act on", () => {
    // Profile and Notifications are theirs. Company & Team is the roster, the
    // only place that answers who their colleagues are. Agents holds the
    // skills they press and the MCP endpoint they point their own agent at.
    // Integrations holds their own API keys.
    expect(labels(member)).toEqual([
      "Profile",
      "Notifications",
      "Company & Team",
      "Agents",
      "Integrations",
    ]);
  });

  it("keeps Products and Cards for a product admin who does not own the workspace", () => {
    // These two are editable by the admin of a single product, so hiding them
    // on workspace role alone would take away the screens that grant exists
    // for.
    expect(labels({ ...member, managesAnyProduct: true })).toEqual([
      "Profile",
      "Notifications",
      "Company & Team",
      "Products",
      "Cards",
      "Agents",
      "Integrations",
    ]);
  });

  it("drops Email on a hosted tenant, even for the owner", () => {
    expect(labels({ ...owner, canConfigureMail: false })).not.toContain("Email");
  });

  it("never offers Email to a member, hosted or not", () => {
    expect(labels(member)).not.toContain("Email");
    expect(labels({ ...member, canConfigureMail: false })).not.toContain(
      "Email",
    );
  });

  it("hides Branding from a member, which is a placeholder nobody can configure", () => {
    expect(labels(member)).not.toContain("Branding");
    expect(labels(owner)).toContain("Branding");
  });

  it("offers Agents to a member, unlike the Assistant entry it replaced", () => {
    // Assistant was owner-only in this list while its own page said every
    // member reads it, and members do press skill buttons and do need the MCP
    // endpoint. The owner-only cards on the page gate themselves.
    expect(labels(member)).toContain("Agents");
    expect(labels(member)).not.toContain("Assistant");
  });
});
