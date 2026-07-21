import { describe, expect, it } from "vitest";

import { InvalidPatchError, parseBulkPatchRequest } from "./features-service";

describe("parseBulkPatchRequest", () => {
  const ids = ["11111111-1111-1111-1111-111111111111"];

  it("accepts a status patch and dedupes specIds", () => {
    const req = parseBulkPatchRequest({
      specIds: [...ids, ...ids],
      patch: { status: "in_progress" },
    });
    expect(req.specIds).toEqual(ids);
    expect(req.patch).toEqual({ status: "in_progress" });
    expect(req.tagOps).toEqual({});
  });

  it("rejects an empty selection", () => {
    expect(() => parseBulkPatchRequest({ specIds: [], patch: { status: "x" } })).toThrow(
      InvalidPatchError,
    );
  });

  it("rejects a disallowed patch field", () => {
    expect(() =>
      parseBulkPatchRequest({ specIds: ids, patch: { title: "no" } }),
    ).toThrow(InvalidPatchError);
  });

  it("rejects a request that changes nothing", () => {
    expect(() => parseBulkPatchRequest({ specIds: ids, patch: {} })).toThrow(
      InvalidPatchError,
    );
    expect(() => parseBulkPatchRequest({ specIds: ids })).toThrow(InvalidPatchError);
  });

  it("accepts a tag-only request and trims/dedupes tags", () => {
    const req = parseBulkPatchRequest({
      specIds: ids,
      addTags: [" urgent ", "urgent", "", "p1"],
    });
    expect(req.patch).toEqual({});
    expect(req.tagOps.addTags).toEqual(["urgent", "p1"]);
  });

  it("accepts clearTags on its own", () => {
    const req = parseBulkPatchRequest({ specIds: ids, clearTags: true });
    expect(req.tagOps.clearTags).toBe(true);
  });

  it("rejects combining addTags and clearTags", () => {
    expect(() =>
      parseBulkPatchRequest({ specIds: ids, addTags: ["x"], clearTags: true }),
    ).toThrow(InvalidPatchError);
  });

  it("enforces the batch size cap", () => {
    const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    expect(() =>
      parseBulkPatchRequest({ specIds: many, patch: { status: "x" } }),
    ).toThrow(InvalidPatchError);
  });
});
