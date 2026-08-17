import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  commonModels,
  credentialPatch,
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

  it("does not arm the disconnect until it is asked for", () => {
    // Disconnecting destroys a credential that cannot be read back, so the
    // first click must open the confirmation rather than perform the delete.
    // What this pins is that the confirmation is not sitting open by default,
    // which would train people to click through it.
    const html = render(connected);
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Disconnect this model?");
    expect(html).not.toContain("Disconnect and destroy the key");
  });
});

/**
 * What a save says about the credential.
 *
 * The tri-state is the whole of rotation and revocation from the browser's
 * side, and both ways of getting it wrong are quiet: sending nothing where null
 * was meant leaves a key an admin believes they revoked, and sending null where
 * nothing was meant breaks the connection because someone edited the model
 * name. Neither shows up as an error.
 */
describe("the credential field on a save", () => {
  it("is absent when nothing was typed, keeping the stored key", () => {
    expect(credentialPatch("", false)).toEqual({});
    expect("apiKey" in credentialPatch("   ", false)).toBe(false);
  });

  it("is null when the stored key was asked to go", () => {
    expect(credentialPatch("", true)).toEqual({ apiKey: null });
  });

  it("carries a typed key, trimmed, which is what rotation is", () => {
    expect(credentialPatch("  sk-live-123  ", false)).toEqual({ apiKey: "sk-live-123" });
  });

  it("lets a typed key override a pending removal", () => {
    // Asking to remove the key and then pasting one is a change of mind, not a
    // request to destroy the key that was just typed.
    expect(credentialPatch("sk-new", true)).toEqual({ apiKey: "sk-new" });
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

/**
 * Which models are worth offering first.
 *
 * Fixtures are real ids from the live OpenAI listing, because the point of
 * this filter is the actual shape of a hosted provider's catalogue: 130
 * entries, a quarter of which cannot hold a conversation at all.
 */
describe("the common-model shortlist", () => {
  it("keeps the models that can answer a chat completion", () => {
    const kept = commonModels([
      "gpt-5.6-terra",
      "gpt-4o-mini",
      "o3-pro",
      "claude-sonnet-5",
      "llama3.1",
      "gpt-5-search-api",
      "gpt-4o-mini-search-preview",
    ]);
    // Search-preview and search-api are text models with a tool attached, so
    // they stay. Hiding a usable model is the expensive mistake here.
    expect(kept).toHaveLength(7);
  });

  it("drops speech, images, embeddings, moderation and video", () => {
    const kept = commonModels([
      "gpt-4o",
      "whisper-1",
      "tts-1-hd",
      "gpt-4o-mini-tts",
      "gpt-4o-transcribe",
      "text-embedding-3-large",
      "omni-moderation-latest",
      "gpt-image-1",
      "chatgpt-image-latest",
      "sora-2-pro",
      "gpt-realtime-mini",
      "gpt-audio",
    ]);
    expect(kept).toEqual(["gpt-4o"]);
  });

  it("keeps a name it has never seen rather than hiding it", () => {
    // The filter is a guess about names. A self-hosted model called something
    // nobody predicted must still be selectable.
    expect(commonModels(["my-finetune-v3", "internal-gateway-model"])).toEqual([
      "my-finetune-v3",
      "internal-gateway-model",
    ]);
  });

  it("shows everything rather than nothing when it recognises none of them", () => {
    // An endpoint serving only speech models is far likelier to be a catalogue
    // this filter does not understand than a genuinely unusable connection.
    expect(commonModels(["whisper-1", "tts-1"])).toEqual(["whisper-1", "tts-1"]);
  });

  it("does not match a fragment inside a longer word", () => {
    // "imagen" contains "image"; the separators are what stop this filter
    // quietly eating models whose names merely resemble a media family.
    expect(commonModels(["imagenious-7b", "reimagine-large"])).toEqual([
      "imagenious-7b",
      "reimagine-large",
    ]);
  });
});
