import { describe, expect, it } from "vitest";

import { parseIdeaSettingsPatch } from "./ideas-service";
import { InvalidPatchError } from "./service-errors";

/**
 * The validation in front of the portal's visibility model.
 *
 * This patch decides what a public, unauthenticated page may show, so the
 * interesting cases are not "does it accept good input" but the three ways a
 * settings patch can quietly publish more than the admin asked for: an empty
 * list mistaken for an absent field, a duplicate turning a save into a
 * constraint violation, and an unrecognised moderation value landing in a
 * column whose CHECK is the only thing between "wait for review" and "publish
 * immediately".
 */

describe("parseIdeaSettingsPatch", () => {
  it("distinguishes an empty list from an absent field", () => {
    // The distinction the whole model rests on. `[]` is how an admin unpublishes
    // every product; absent means "leave the product set alone". Conflating them
    // makes unpublishing impossible, and does it silently: the save succeeds and
    // the portal keeps serving.
    expect(parseIdeaSettingsPatch({ portalProductIds: [] })).toEqual({
      portalProductIds: [],
    });
    expect(parseIdeaSettingsPatch({ portalEnabled: true })).toEqual({
      portalEnabled: true,
    });
    expect(
      "portalProductIds" in parseIdeaSettingsPatch({ portalEnabled: true }),
    ).toBe(false);
  });

  it("deduplicates a set rather than failing the save", () => {
    // `idea_portal_products` is uniquely constrained on (workspace, product), so
    // a repeated id would abort the transaction with a message about a
    // constraint the admin has never heard of. Ticking a box twice is not an
    // error worth surfacing.
    expect(
      parseIdeaSettingsPatch({ portalProductIds: ["a", "b", "a"] }),
    ).toEqual({ portalProductIds: ["a", "b"] });
  });

  it("trims, and refuses blank entries", () => {
    expect(
      parseIdeaSettingsPatch({ portalIdeaStatuses: [" planned ", "shipped"] }),
    ).toEqual({ portalIdeaStatuses: ["planned", "shipped"] });
    // A blank key would match no stage and publish nothing, so it is harmless
    // but meaningless; refusing it means a form bug surfaces as an error rather
    // than as an empty portal somebody debugs later.
    expect(() =>
      parseIdeaSettingsPatch({ portalIdeaStatuses: ["planned", "  "] }),
    ).toThrow(InvalidPatchError);
  });

  it("refuses a moderation value the database would refuse", () => {
    // The column carries a CHECK, so an unrecognised value is a 500 from
    // Postgres rather than a 422 from here. Worse, the two legitimate values
    // differ by whether strangers' submissions appear on a customer's branded
    // page without review, so this is not a field to be lenient about.
    expect(parseIdeaSettingsPatch({ portalModeration: "immediate" })).toEqual({
      portalModeration: "immediate",
    });
    expect(() =>
      parseIdeaSettingsPatch({ portalModeration: "publish_everything" }),
    ).toThrow(/portalModeration must be one of/);
    expect(() => parseIdeaSettingsPatch({ portalModeration: true })).toThrow(
      InvalidPatchError,
    );
  });

  it("refuses a list that is not a list of strings", () => {
    expect(() =>
      parseIdeaSettingsPatch({ portalProductIds: "a-single-id" }),
    ).toThrow(/must be an array of strings/);
    expect(() => parseIdeaSettingsPatch({ portalProductIds: [1, 2] })).toThrow(
      /non-empty strings/,
    );
  });

  it("refuses a patch that sets nothing, naming every field it accepts", () => {
    // An empty patch reaching the store would rewrite the row with its own
    // current values and bump `updatedAt`, which reads as a change nobody made.
    expect(() => parseIdeaSettingsPatch({})).toThrow(/at least one of/);
    for (const field of [
      "portalEnabled",
      "portalTitle",
      "portalProductIds",
      "portalIdeaStatuses",
      "portalRoadmapEnabled",
      "portalRoadmapItemStatuses",
      "portalModeration",
    ]) {
      // The message is what an API caller gets when they guess a field name, so
      // it has to stay in step with what is actually accepted.
      expect(() => parseIdeaSettingsPatch({})).toThrow(
        new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });

  it("refuses a body that is not an object", () => {
    for (const body of [null, [], "portalEnabled=true", 3]) {
      expect(() => parseIdeaSettingsPatch(body)).toThrow(
        /must be a JSON object/,
      );
    }
  });

  it("takes the roadmap switch and its statuses independently", () => {
    // Two fields rather than one, because a roadmap switched on with no
    // published item statuses is a legitimate intermediate state: the admin has
    // decided to have a roadmap and not yet which stages outsiders see.
    expect(
      parseIdeaSettingsPatch({
        portalRoadmapEnabled: true,
        portalRoadmapItemStatuses: [],
      }),
    ).toEqual({ portalRoadmapEnabled: true, portalRoadmapItemStatuses: [] });
  });
});
