import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DescriptionBlock, isFoldableBody } from "./description-block";

/**
 * When the Description block offers to fold, and when it refuses to.
 *
 * Both halves matter and they fail in opposite directions. Offering the control
 * on a one-paragraph card puts a permanent piece of furniture on the most
 * common item in the product; refusing to offer it while an editor holds
 * unsaved text would fold that text away, and folding unmounts the editor.
 *
 * Rendered to static markup, as the other component tests here are: the server
 * snapshot of the stored preference is "not collapsed", so this covers the
 * expanded and the refusing states. The folded rendering needs a browser and is
 * left to manual and e2e coverage rather than faked here.
 */

const SHORT = "A sentence about the checkout flow.";
const LONG = "A paragraph about the checkout flow. ".repeat(30);

function render(props: { body: string; dirty?: boolean }) {
  return renderToStaticMarkup(
    <DescriptionBlock itemId="spec-1" links={[]} {...props}>
      <p>the editor</p>
    </DescriptionBlock>,
  );
}

describe("isFoldableBody", () => {
  it("leaves a short body alone", () => {
    expect(isFoldableBody(SHORT)).toBe(false);
    expect(isFoldableBody("")).toBe(false);
    expect(isFoldableBody("   \n  ")).toBe(false);
  });

  it("folds a long body", () => {
    expect(isFoldableBody(LONG)).toBe(true);
  });

  it("folds a body that is many short lines rather than much text", () => {
    // A checklist or a table is short by character count and still fills the
    // screen, which is the thing being fixed.
    expect(isFoldableBody("- one\n".repeat(20))).toBe(true);
  });
});

describe("DescriptionBlock", () => {
  it("shows no fold control on a body that does not need one", () => {
    const html = render({ body: SHORT });
    expect(html).not.toContain("Show less");
    expect(html).not.toContain("Show more");
    expect(html).toContain("the editor");
  });

  it("offers the control on a long body, and still opens expanded", () => {
    // Collapsing by default would hide content nobody asked to hide, and the
    // first visit to a long spec is the visit that came to read it.
    const html = render({ body: LONG });
    expect(html).toContain("Show less");
    expect(html).toContain("the editor");
  });

  it("refuses to fold while the body has unsaved changes", () => {
    // Folding unmounts the editor, and this editor drops a pending debounce on
    // unmount. Disabled, with a reason, rather than silently doing nothing.
    const html = render({ body: LONG, dirty: true });
    expect(html).toContain("disabled");
    expect(html).toContain("Finish or save your changes");
    expect(html).toContain("the editor");
  });

  it("keeps the body visible when it is not foldable, dirty or not", () => {
    expect(render({ body: SHORT, dirty: true })).toContain("the editor");
  });
});
