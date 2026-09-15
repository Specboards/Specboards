import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProposalReview } from "./assistant-panel";

/**
 * A proposal, on the first render anybody ever sees of it.
 *
 * ── The bug this exists for ───────────────────────────────────────────────
 * Every change in a proposal starts ticked, and the reviewer unticks what
 * they do not want. That selection was seeded by a mount effect until #432
 * swapped the effect for `useResetOnChange`, which deliberately does NOT run
 * on mount: it fires when its key changes. Nothing changed the key on a fresh
 * proposal, so the selection stayed empty, and every proposal arrived with a
 * disabled "Accept 0 of 1 changes" and no way to take it.
 *
 * Rendering to static markup is exactly the right test for that, because the
 * failure was entirely in the first render. Anything that interacted with the
 * component first would have moved the key and hidden it.
 */

const CURRENT = "# Checkout\n\nThe old description.\n";
const PROPOSED = "# Checkout\n\nA much better description.\n";

const OPEN = { outcome: null, resolvedByName: null, resolvedAt: null, commitSha: null };

const render = (canEdit = true) =>
  renderToStaticMarkup(
    <ProposalReview
      proposed={PROPOSED}
      current={CURRENT}
      state={OPEN}
      canEdit={canEdit}
      busy={false}
      onResolve={() => {}}
    />,
  );

describe("a proposal on first render", () => {
  it("arrives with every change already ticked", () => {
    const html = render();
    // The whole proposal is taken, so the button is the plain "Accept" rather
    // than the partial-selection label.
    expect(html).toContain(">Accept<");
    expect(html).not.toContain("Accept 0 of");
  });

  it("does not tell the reviewer nothing is ticked", () => {
    // The hint that appears when a reviewer has unticked everything. Seeing
    // it before touching anything is the reported symptom.
    expect(render()).not.toContain("Nothing is ticked");
  });

  it("leaves the Accept button usable", () => {
    const html = render();
    // The ATTRIBUTE, not the substring: the class list carries Tailwind's
    // `disabled:` variants on every button whether or not it is disabled,
    // which is a trap worth leaving a note about.
    // Located by a prefix, not by the exact label: the broken version reads
    // "Accept 0 of 1 changes", and matching the whole string meant this
    // assertion quietly inspected the Reject button and passed. Verified by
    // reverting the fix and watching it fail.
    const at = html.indexOf(">Accept");
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(0, at).slice(html.slice(0, at).lastIndexOf("<button"));
    expect(tag).not.toContain('disabled=""');
  });

  it("would have caught the bug it exists for", () => {
    // A proof that the assertion above can fail: the Reject button is enabled
    // here, so if `disabled=""` never appeared in this markup at all the test
    // would be vacuous. Render a busy panel, where Accept genuinely is off.
    const busy = renderToStaticMarkup(
      <ProposalReview
        proposed={PROPOSED}
        current={CURRENT}
        state={OPEN}
        canEdit
        busy
        onResolve={() => {}}
      />,
    );
    expect(busy).toContain('disabled=""');
  });

  it("offers nothing to a reader who cannot act", () => {
    const html = render(false);
    expect(html).not.toContain(">Accept<");
    expect(html).not.toContain("Reject");
  });
});
