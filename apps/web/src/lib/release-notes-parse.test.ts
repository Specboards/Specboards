import { describe, expect, it } from "vitest";

import {
  parseReleaseInput,
  parseReleaseNotesPatch,
  parseReleasePatch,
} from "./releases-service";
import { InvalidPatchError } from "./service-errors";

describe("parseReleaseInput - customer-facing release notes", () => {
  it("defaults the release-notes fields to absent when unspecified", () => {
    const input = parseReleaseInput({ name: "v1.0" });
    expect(input.releaseNotesMode).toBeUndefined();
    expect(input.releaseNotesBody).toBeUndefined();
    expect(input.releaseNotesUrl).toBeUndefined();
  });

  it("accepts an in_app mode with a Markdown body", () => {
    const input = parseReleaseInput({
      name: "v1.0",
      releaseNotesMode: "in_app",
      releaseNotesBody: "  # Highlights\n- Faster boards  ",
    });
    expect(input.releaseNotesMode).toBe("in_app");
    // Body is trimmed.
    expect(input.releaseNotesBody).toBe("# Highlights\n- Faster boards");
  });

  it("accepts an external mode with an http(s) URL", () => {
    const input = parseReleaseInput({
      name: "v1.0",
      releaseNotesMode: "external",
      releaseNotesUrl: "https://example.com/notes",
    });
    expect(input.releaseNotesMode).toBe("external");
    expect(input.releaseNotesUrl).toBe("https://example.com/notes");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      parseReleaseInput({ name: "v1.0", releaseNotesMode: "public" }),
    ).toThrow(InvalidPatchError);
  });
});

describe("parseReleasePatch - customer-facing release notes", () => {
  it("treats an empty body as clearing it (null)", () => {
    const patch = parseReleasePatch({ releaseNotesBody: "   " });
    expect(patch.releaseNotesBody).toBeNull();
  });

  it("treats an empty URL as clearing it (null)", () => {
    const patch = parseReleasePatch({ releaseNotesUrl: "" });
    expect(patch.releaseNotesUrl).toBeNull();
  });

  it("accepts an explicit null to clear a field", () => {
    const patch = parseReleasePatch({ releaseNotesUrl: null });
    expect(patch.releaseNotesUrl).toBeNull();
  });

  it("rejects a non-http(s) URL scheme", () => {
    expect(() =>
      parseReleasePatch({ releaseNotesUrl: "javascript:alert(1)" }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a malformed URL", () => {
    expect(() =>
      parseReleasePatch({ releaseNotesUrl: "not a url" }),
    ).toThrow(InvalidPatchError);
  });

  it("counts a release-notes field as a real change for the empty-patch guard", () => {
    // A patch that only sets the mode must not trip the "at least one field"
    // guard that parseReleasePatch enforces.
    expect(() =>
      parseReleasePatch({ releaseNotesMode: "none" }),
    ).not.toThrow();
  });

  it("still rejects a genuinely empty patch", () => {
    expect(() => parseReleasePatch({})).toThrow(InvalidPatchError);
  });
});

describe("parseReleaseNotesPatch (update_release_notes tool)", () => {
  it("infers in_app mode from a non-empty body", () => {
    const patch = parseReleaseNotesPatch({
      id: "r1",
      body: "## What's new",
    });
    expect(patch.releaseNotesMode).toBe("in_app");
    expect(patch.releaseNotesBody).toBe("## What's new");
    // Never sets an unrelated field.
    expect(patch.name).toBeUndefined();
    expect(patch.status).toBeUndefined();
    expect(patch.notes).toBeUndefined();
  });

  it("infers external mode from a non-empty url", () => {
    const patch = parseReleaseNotesPatch({
      id: "r1",
      url: "https://example.com/notes",
    });
    expect(patch.releaseNotesMode).toBe("external");
    expect(patch.releaseNotesUrl).toBe("https://example.com/notes");
  });

  it("clears to none when the body is emptied without an explicit mode", () => {
    const patch = parseReleaseNotesPatch({ id: "r1", body: "" });
    expect(patch.releaseNotesMode).toBe("none");
    expect(patch.releaseNotesBody).toBeNull();
  });

  it("honors an explicit mode override", () => {
    const patch = parseReleaseNotesPatch({ id: "r1", mode: "none" });
    expect(patch.releaseNotesMode).toBe("none");
  });

  it("rejects supplying both a body and a url", () => {
    expect(() =>
      parseReleaseNotesPatch({
        id: "r1",
        body: "hi",
        url: "https://example.com",
      }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a payload with no notes fields (id alone)", () => {
    expect(() => parseReleaseNotesPatch({ id: "r1" })).toThrow(
      InvalidPatchError,
    );
  });

  it("never produces the internal notes or scheduling fields", () => {
    const patch = parseReleaseNotesPatch({
      id: "r1",
      body: "notes",
      // These must be ignored, not applied.
      name: "hacked",
      status: "shipped",
      notes: "internal",
      productId: "p1",
    });
    expect(patch.name).toBeUndefined();
    expect(patch.status).toBeUndefined();
    expect(patch.notes).toBeUndefined();
    expect(patch.productId).toBeUndefined();
  });
});
