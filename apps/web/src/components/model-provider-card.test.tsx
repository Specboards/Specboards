import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ModelProviderCard,
  modelPickerOptions,
  type ModelProviderView,
} from "./model-provider-card";

/**
 * What the Model card renders before anyone interacts with it.
 *
 * The property worth pinning in markup is that a credential can never appear
 * here. The view type has no field that could carry one, so this is really a
 * guard against someone widening that type later: if a key ever reaches this
 * component, these assertions are what notices.
 *
 * Also covered: the "add" UX rule (no form sitting open by default) and that a
 * non-owner gets no controls. Behaviour behind the buttons lives in
 * `model-provider.int.test.ts`, which drives it against a real database.
 */

const connected: ModelProviderView = {
  id: "mp-1",
  kind: "openai_compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  enabled: true,
  credentialHint: "a91c",
  lastUsedAt: "2026-08-16T12:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const render = (provider: ModelProviderView | null, canManage = true) =>
  renderToStaticMarkup(
    <ModelProviderCard initialProvider={provider} canManage={canManage} />,
  );

describe("with nothing connected", () => {
  it("offers the affordance rather than an open form", () => {
    const html = render(null);
    expect(html).toContain("Connect a model");
    // The "add starts as an affordance" rule: a blank form sitting open reads
    // as unfinished for the common case where nobody is connecting anything.
    expect(html).not.toContain('id="model-base-url"');
    expect(html).not.toContain('id="model-api-key"');
  });

  it("gives a non-owner no way to connect one", () => {
    const html = render(null, false);
    expect(html).not.toContain("Connect a model");
    expect(html).toContain("Only the workspace owner");
  });
});

describe("with a connection", () => {
  it("shows the endpoint and model but only a masked key hint", () => {
    const html = render(connected);
    expect(html).toContain("https://api.openai.com/v1");
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("••••a91c");
  });

  it("renders no form until Edit is pressed", () => {
    expect(render(connected)).not.toContain('id="model-api-key"');
  });

  it("says plainly when the endpoint takes no key", () => {
    // A keyless local endpoint is a real configuration; it must not read as a
    // half-finished setup.
    const html = render({ ...connected, credentialHint: null });
    expect(html).toContain("None (endpoint takes no key)");
  });

  it("distinguishes a never-used connection from a live one", () => {
    expect(render({ ...connected, lastUsedAt: null })).toContain("Never");
  });

  it("renders a timestamp the browser will agree with", () => {
    // This is the regression that killed the card. `toLocaleString()` renders
    // in the server's timezone here and the viewer's on hydration; React reads
    // the difference as a corrupted tree, throws #418, and never attaches the
    // click handlers, so every button goes dead with no error on screen. The
    // server's first render must be timezone-independent.
    const html = render(connected);
    expect(html).toContain("2026-08-16 12:00 UTC");
    expect(html).not.toContain(new Date(connected.lastUsedAt!).toLocaleString());
  });

  it("gives a non-owner no management controls", () => {
    const html = render(connected, false);
    expect(html).not.toContain("Send a test call");
    expect(html).not.toContain("Disconnect");
    // Still shows what is configured, which is the point of an owner-only tab.
    expect(html).toContain("gpt-4o-mini");
  });
});

describe("the model picker's options", () => {
  it("offers nothing until an endpoint has listed something", () => {
    // Both "not asked yet" and "asked, got nothing" fall back to a text field:
    // a self-hosted runtime serving one set of weights is a working setup.
    expect(modelPickerOptions(null, "gpt-4o-mini")).toEqual([]);
    expect(modelPickerOptions([], "gpt-4o-mini")).toEqual([]);
  });

  it("keeps a configured model the endpoint did not list", () => {
    // A gateway alias, or a name since retired. Dropping it would switch the
    // workspace's model to whatever sorted first, without anyone choosing it.
    expect(modelPickerOptions(["a", "b"], "house-alias")).toEqual(["house-alias", "a", "b"]);
  });

  it("does not duplicate a configured model that was listed", () => {
    expect(modelPickerOptions(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("offers the list as-is when nothing is configured yet", () => {
    expect(modelPickerOptions(["a", "b"], "")).toEqual(["a", "b"]);
  });
});
