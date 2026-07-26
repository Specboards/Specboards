import { describe, expect, it } from "vitest";

import { withViewParams } from "@/lib/backlog-query";

/** Stand-in for Next's ReadonlyURLSearchParams. */
function current(query: string) {
  return new URLSearchParams(query);
}

describe("withViewParams", () => {
  it("carries the view, level, and sort onto a rebuilt filter query", () => {
    const merged = withViewParams(
      "status=ready",
      current("view=list&level=epic&sort=rice&status=done"),
    );
    const params = new URLSearchParams(merged);
    expect(params.get("status")).toBe("ready");
    expect(params.get("view")).toBe("list");
    expect(params.get("level")).toBe("epic");
    expect(params.get("sort")).toBe("rice");
  });

  it("keeps the level when every filter is cleared", () => {
    expect(withViewParams("", current("view=list&level=initiative"))).toBe(
      "view=list&level=initiative",
    );
  });

  it("lets the caller's own value win", () => {
    const merged = withViewParams("view=board", current("view=list"));
    expect(new URLSearchParams(merged).get("view")).toBe("board");
  });

  it("omits params the current URL doesn't have", () => {
    expect(withViewParams("tag=ux", current(""))).toBe("tag=ux");
  });

  it("ignores non-view params from the current URL", () => {
    const merged = withViewParams("", current("status=done&assignee=u1"));
    expect(merged).toBe("");
  });
});
