import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TransitionModeEditor } from "./transition-mode-editor";
import type { TransitionModeSettings } from "@/lib/store/types";

/**
 * What the Transitions control shows before anyone touches it.
 *
 * The interesting cases are all about the difference between inheriting and
 * overriding, which is the distinction this epic exists to introduce and the
 * one a reader of the screen has to be able to see. Rendering to static markup
 * keeps this a plain assertion about output with no DOM or test-runner
 * dependencies; the interactive behaviour is covered where it actually
 * matters, by the route tests.
 *
 * The three modules a client component reaches for are stubbed because none of
 * them is what is under test here.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: () => {} } }));
vi.mock("@/lib/api-client", () => ({
  AuthRequiredError: class extends Error {},
  updateTransitionMode: async () => "flexible",
}));

const stages = [
  { key: "backlog", label: "Backlog", position: 0 },
  { key: "ready", label: "Ready", position: 1 },
];

function render(
  settings: TransitionModeSettings,
  productId: string | null,
  canEdit = true,
) {
  return renderToStaticMarkup(
    <TransitionModeEditor
      initial={settings}
      productId={productId}
      stages={stages}
      canEdit={canEdit}
    />,
  );
}

/** The radio the markup has actually ticked, by its value. */
function checkedMode(html: string): string | null {
  return /<input[^>]*checked=""[^>]*value="([^"]+)"/.exec(html)?.[1] ?? null;
}

const defaults: TransitionModeSettings = {
  workspaceDefault: "flexible",
  overrides: {},
};

describe("TransitionModeEditor", () => {
  it("offers no Inherit option on the workspace default", () => {
    // Nothing sits below the default, so offering to inherit would be a lie.
    const html = render(defaults, null);
    expect(html).not.toContain("Inherit (");
    expect(checkedMode(html)).toBe("flexible");
  });

  it("shows a product with no override as inheriting, and names what it gets", () => {
    // Reading "Inherit" on its own leaves you to go and look up what that is.
    const html = render(defaults, "p-alpha");
    expect(html).toContain("Inherit (Flexible)");
    expect(checkedMode(html)).toBe("inherit");
  });

  it("shows a product's own mode once it has overridden", () => {
    const html = render(
      { workspaceDefault: "flexible", overrides: { "p-alpha": "strict" } },
      "p-alpha",
    );
    expect(checkedMode(html)).toBe("strict");
  });

  it("keeps products independent of each other", () => {
    const settings: TransitionModeSettings = {
      workspaceDefault: "flexible",
      overrides: { "p-alpha": "strict" },
    };
    expect(checkedMode(render(settings, "p-alpha"))).toBe("strict");
    expect(checkedMode(render(settings, "p-beta"))).toBe("inherit");
  });

  it("names the current default, so an inheriting product tracks it", () => {
    const html = render({ workspaceDefault: "strict", overrides: {} }, "p-beta");
    expect(html).toContain("Inherit (Strict)");
  });

  it("disables the controls for someone who may not edit", () => {
    expect(render(defaults, "p-alpha", false)).toContain('disabled=""');
  });

  it("phrases strict with the workspace's own first two stages", () => {
    expect(render(defaults, null)).toContain("Backlog to Ready");
  });
});
