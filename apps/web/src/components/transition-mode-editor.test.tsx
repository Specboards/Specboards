import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TransitionModeEditor } from "./transition-mode-editor";
import type { ProductRecord, TransitionModeSettings } from "@/lib/store/types";

/**
 * What the Transitions control shows before anyone touches it.
 *
 * The interesting cases are all about the difference between inheriting and
 * overriding, which is the distinction this whole slice exists to introduce and
 * the one a reader of the screen has to be able to see. Rendering to static
 * markup keeps this a plain assertion about output with no DOM or test-runner
 * dependencies: the interactive behaviour is covered where it actually
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

function product(id: string, name: string): ProductRecord {
  return {
    id,
    key: name.toLowerCase(),
    name,
    description: null,
    visibility: "org",
    position: 0,
    color: null,
    groupId: null,
    itemCount: 0,
    viewerRole: null,
  };
}

const alpha = product("p-alpha", "Alpha");
const beta = product("p-beta", "Beta");

const stages = [
  { key: "backlog", label: "Backlog", position: 0 },
  { key: "ready", label: "Ready", position: 1 },
];

function render(
  settings: TransitionModeSettings,
  products: ProductRecord[],
  overrides: Partial<{
    canEditDefault: boolean;
    manageableProductIds: string[];
  }> = {},
) {
  return renderToStaticMarkup(
    <TransitionModeEditor
      initial={settings}
      products={products}
      stages={stages}
      canEditDefault={overrides.canEditDefault ?? true}
      manageableProductIds={overrides.manageableProductIds ?? []}
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
  it("hides the scope picker until there is more than one product", () => {
    expect(render(defaults, [alpha])).not.toContain("Configuring");
    expect(render(defaults, [alpha, beta])).toContain("Configuring");
  });

  it("opens on the workspace default, with no Inherit option there", () => {
    const html = render(defaults, [alpha, beta]);
    // Nothing sits below the default, so offering to inherit would be a lie.
    expect(html).not.toContain("Inherit (");
    expect(checkedMode(html)).toBe("flexible");
  });

  it("marks products that have not overridden the default", () => {
    const html = render(
      { workspaceDefault: "flexible", overrides: { "p-alpha": "strict" } },
      [alpha, beta],
    );
    // Alpha has taken its own line; Beta is still following the workspace, and
    // the picker says so before you select it.
    expect(html).toContain(">Alpha</option>");
    expect(html).toContain(">Beta (inherited)</option>");
  });

  it("names the mode being inherited rather than just saying inherited", () => {
    // Reading "Inherit" alone leaves you to go and look up what that is.
    expect(render(defaults, [alpha, beta])).toContain("flexible");
    const strict = render({ workspaceDefault: "strict", overrides: {} }, [
      alpha,
      beta,
    ]);
    expect(checkedMode(strict)).toBe("strict");
  });

  it("disables the controls for someone who may not edit", () => {
    const html = render(defaults, [alpha, beta], {
      canEditDefault: false,
      manageableProductIds: ["p-alpha"],
    });
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Only the workspace owner can change the default.");
  });

  it("phrases strict with the workspace's own first two stages", () => {
    expect(render(defaults, [alpha])).toContain("Backlog to Ready");
  });
});
