import { describe, expect, it } from "vitest";

import { InvalidPatchError, parseSpecCreateInput } from "./features-service";

const ITEM = "11111111-2222-3333-4444-555555555555";
const PARENT = "66666666-7777-8888-9999-aaaaaaaaaaaa";

describe("parseSpecCreateInput", () => {
  it("accepts a title on its own", () => {
    expect(parseSpecCreateInput({ title: "Attach a spec" })).toEqual({
      title: "Attach a spec",
    });
  });

  it("trims the title, since the slug and the commit both derive from it", () => {
    expect(parseSpecCreateInput({ title: "  Attach a spec  " })).toEqual({
      title: "Attach a spec",
    });
  });

  it("keeps an attach target", () => {
    expect(parseSpecCreateInput({ title: "T", workItemId: ITEM })).toEqual({
      title: "T",
      workItemId: ITEM,
    });
  });

  it("keeps a parent for a brand-new spec", () => {
    expect(parseSpecCreateInput({ title: "T", parentSpecId: PARENT })).toEqual({
      title: "T",
      parentSpecId: PARENT,
    });
  });

  it("rejects attaching and re-parenting in one request", () => {
    // Attaching must never move the item it attaches to: that item already has
    // a parent someone chose.
    expect(() =>
      parseSpecCreateInput({ title: "T", workItemId: ITEM, parentSpecId: PARENT }),
    ).toThrow(InvalidPatchError);
  });

  it("accepts an empty body: starting from the stub is a real choice", () => {
    expect(parseSpecCreateInput({ title: "T", body: "" })).toEqual({
      title: "T",
      body: "",
    });
  });

  it("keeps a body when one is seeded", () => {
    expect(parseSpecCreateInput({ title: "T", body: "## Problem\n" })).toEqual({
      title: "T",
      body: "## Problem\n",
    });
  });

  it("drops a blank commit message so the generated one is used", () => {
    expect(parseSpecCreateInput({ title: "T", message: "   " })).toEqual({
      title: "T",
    });
    expect(parseSpecCreateInput({ title: "T", message: null })).toEqual({
      title: "T",
    });
  });

  it("keeps a commit message when one is given", () => {
    expect(parseSpecCreateInput({ title: "T", message: "docs: add spec" })).toEqual(
      { title: "T", message: "docs: add spec" },
    );
  });

  it("treats null and undefined optionals as absent", () => {
    expect(
      parseSpecCreateInput({
        title: "T",
        body: null,
        workItemId: null,
        parentSpecId: undefined,
        repoId: null,
      }),
    ).toEqual({ title: "T" });
  });

  it("rejects a missing, non-string or blank title", () => {
    expect(() => parseSpecCreateInput({})).toThrow(InvalidPatchError);
    expect(() => parseSpecCreateInput({ title: 42 })).toThrow(InvalidPatchError);
    expect(() => parseSpecCreateInput({ title: "   " })).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => parseSpecCreateInput({ title: "T", workItemId: "nope" })).toThrow(
      InvalidPatchError,
    );
    expect(() =>
      parseSpecCreateInput({ title: "T", parentSpecId: "nope" }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a non-string body, repoId or message", () => {
    expect(() => parseSpecCreateInput({ title: "T", body: 7 })).toThrow(
      InvalidPatchError,
    );
    expect(() => parseSpecCreateInput({ title: "T", repoId: "" })).toThrow(
      InvalidPatchError,
    );
    expect(() => parseSpecCreateInput({ title: "T", message: 7 })).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects a non-object body", () => {
    expect(() => parseSpecCreateInput(null)).toThrow(InvalidPatchError);
    expect(() => parseSpecCreateInput("Attach a spec")).toThrow(
      InvalidPatchError,
    );
    expect(() => parseSpecCreateInput([{ title: "T" }])).toThrow(
      InvalidPatchError,
    );
  });
});
