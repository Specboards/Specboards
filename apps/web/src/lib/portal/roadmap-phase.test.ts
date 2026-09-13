import { DEFAULT_STATUSES } from "@specboards/core";
import { describe, expect, it } from "vitest";

import { publicPhase } from "@/lib/portal/roadmap";

/**
 * Mapping a workspace's own stage onto the three words a public roadmap uses.
 *
 * The whole reason this function exists is that the internal vocabulary is not
 * fit to publish: `blocked`, `in_review` and `waiting_on_legal` are all real
 * stage names and none of them is something to tell a customer about the
 * feature they asked for. So the mapping has to be right for workflows nobody
 * has seen, which means it cannot key on names.
 *
 * It keys on POSITION instead, the same property `terminalStatus` in core
 * already relies on. These cases are about the edges of that.
 */
describe("publicPhase", () => {
  const CUSTOM = ["icebox", "scoping", "building", "verifying", "live"];

  it("calls the first stage planned", () => {
    expect(publicPhase("backlog", DEFAULT_STATUSES)).toBe("planned");
    expect(publicPhase("icebox", CUSTOM)).toBe("planned");
  });

  it("calls the last non-archived stage shipped, whatever it is named", () => {
    // The case a name-based mapping gets wrong. `live` is not a word this code
    // knows; it is shipped because of where it sits.
    expect(publicPhase("done", DEFAULT_STATUSES)).toBe("shipped");
    expect(publicPhase("live", CUSTOM)).toBe("shipped");
  });

  it("does not treat `archived` as the end of the pipeline", () => {
    // Core is explicit that archiving is not doneness: "it is how a team says
    // they are not doing something, so counting it as finished would let
    // abandoning work look like delivering it." That matters more in public
    // than internally, where it would tell a customer their request shipped.
    expect(publicPhase("archived", DEFAULT_STATUSES)).not.toBe("shipped");
    expect(publicPhase("done", DEFAULT_STATUSES)).toBe("shipped");
  });

  it.each([["defining"], ["ready"], ["in_progress"], ["in_review"]])(
    "calls the middle stage %s in progress",
    (status) => {
      expect(publicPhase(status, DEFAULT_STATUSES)).toBe("in_progress");
    },
  );

  it("never leaks the internal name it was given", () => {
    // The output vocabulary is closed. Asserted directly, because the failure
    // mode this whole module exists to prevent is an internal stage name
    // reaching a customer, and a future "just pass it through for unknowns"
    // would look reasonable in isolation.
    for (const status of [...DEFAULT_STATUSES, ...CUSTOM, "waiting_on_legal"]) {
      expect(["planned", "in_progress", "shipped"]).toContain(
        publicPhase(status, DEFAULT_STATUSES),
      );
    }
  });

  it("calls an unrecognised stage planned, not shipped", () => {
    // A key that matches no stage means the workflow changed under us. Planned
    // is the least-committal answer; the alternative is announcing something as
    // delivered on the strength of a key nobody recognises.
    expect(publicPhase("no_such_stage", DEFAULT_STATUSES)).toBe("planned");
  });

  it("must be given the full workflow, not the published subset", () => {
    // The caller's contract, and the bug this test was written for. It was
    // mine: the read model first passed `portal_roadmap_item_statuses`, the
    // admin's tick-list, which is neither in workflow order (the settings UI
    // appends a newly-ticked status) nor starts at the workflow's first stage.
    //
    // This case pins the CONSEQUENCE rather than pretending the function can
    // defend itself. Given only what an admin published, `in_progress` is the
    // last entry, so it maps to shipped: the roadmap would have told customers
    // that work merely under way had already been delivered. There is no way
    // for the function to know better from that input, which is precisely why
    // the argument has to be the real workflow.
    const publishedSubset = ["done", "in_progress"];
    expect(publicPhase("in_progress", publishedSubset)).toBe("shipped");

    // Given the real workflow, the same item is described honestly.
    expect(publicPhase("in_progress", DEFAULT_STATUSES)).toBe("in_progress");
  });
});
