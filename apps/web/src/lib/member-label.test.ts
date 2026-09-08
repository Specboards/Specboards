import { describe, expect, it } from "vitest";

import { memberLabels } from "@/lib/member-label";

/**
 * The rule is "say more only where more is needed", so both halves matter: a
 * shared name has to gain its address, and an unshared one has to keep from
 * gaining one. A version that always appended would pass any test written only
 * for the first half.
 */

const jonathanA = { name: "Jonathan Butler", email: "jonathan@specboards.net" };
const jonathanB = { name: "Jonathan Butler", email: "jonathan@palouse.io" };
const priya = { name: "Priya Raman", email: "priya@specboards.net" };

describe("member labels", () => {
  it("leaves a unique name alone", () => {
    const label = memberLabels([jonathanA, priya]);
    expect(label(jonathanA)).toBe("Jonathan Butler");
    expect(label(priya)).toBe("Priya Raman");
  });

  it("appends the address to each of two people sharing a name", () => {
    const label = memberLabels([jonathanA, jonathanB, priya]);
    expect(label(jonathanA)).toBe("Jonathan Butler (jonathan@specboards.net)");
    expect(label(jonathanB)).toBe("Jonathan Butler (jonathan@palouse.io)");
    // The person who was never ambiguous is untouched by somebody else's
    // collision.
    expect(label(priya)).toBe("Priya Raman");
  });

  it("matches on the exact name, so similar names are left alone", () => {
    const jon = { name: "Jon Butler", email: "jon@specboards.net" };
    const label = memberLabels([jonathanA, jon]);
    expect(label(jonathanA)).toBe("Jonathan Butler");
    expect(label(jon)).toBe("Jon Butler");
  });

  it("ignores the padding around a name when deciding", () => {
    const padded = { name: "  Jonathan Butler  ", email: "jb@elsewhere.test" };
    const label = memberLabels([jonathanA, padded]);
    expect(label(padded)).toBe("Jonathan Butler (jb@elsewhere.test)");
  });

  it("falls back to the address, and then to a placeholder, for a nameless person", () => {
    const nameless = { name: "", email: "ghost@specboards.net" };
    const nothing = { name: null, email: null };
    const label = memberLabels([nameless, nothing]);
    // No parenthetical: the address is the name here, not a tiebreaker.
    expect(label(nameless)).toBe("ghost@specboards.net");
    expect(label(nothing)).toBe("Unknown member");
  });

  it("cannot disambiguate somebody with no address, and says the name plainly", () => {
    const noEmail = { name: "Jonathan Butler", email: null };
    const label = memberLabels([jonathanA, noEmail]);
    expect(label(jonathanA)).toBe("Jonathan Butler (jonathan@specboards.net)");
    // Nothing to append. A bare "Jonathan Butler ()" would be worse than the
    // ambiguity it was trying to resolve.
    expect(label(noEmail)).toBe("Jonathan Butler");
  });
});
