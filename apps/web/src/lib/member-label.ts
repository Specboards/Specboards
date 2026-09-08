/**
 * How a person is named in a list of people.
 *
 * Display names are not unique and nothing makes them so. The same human with
 * two accounts, two colleagues who happen to share a name, and a workspace
 * that has invited a contractor under the name already on its roster all
 * produce the same picker: two options, identical text, and no way to tell
 * which is which except by choosing one and seeing what happens. Assignment is
 * the worst place for that, because the wrong choice is silent and lands the
 * work in somebody else's queue.
 *
 * The tiebreaker is the email address, which is the identity people actually
 * recognise and the one thing the roster is guaranteed to hold uniquely.
 *
 * ── Why only when it is ambiguous ───────────────────────────────────────────
 * Appending the address to every option would fix the rare workspace at the
 * cost of every other one: an assignee dropdown reading "Jonathan Butler
 * (jonathan@specboards.net)" on every row is longer, truncates sooner in a
 * narrow control, and buries the name in the noise of a domain repeated on
 * every line. The address is there to answer a question, so it appears where
 * there is a question to answer.
 *
 * Compared on the exact display name after trimming. Two people called
 * "Jon Butler" and "Jonathan Butler" are told apart by their names already,
 * and a fuzzy match would start disambiguating people who are not ambiguous.
 */

/** The least a person has to carry to be named in a list. Not exported: every
 * caller passes a `WorkspaceMember` (or the roster shape a page already holds)
 * and lets it structurally match, so naming the type buys nothing. */
interface LabelledMember {
  name?: string | null;
  email?: string | null;
}

/** A person with nothing usable to show, which the store should never produce
 * but the type system permits at several of these call sites. */
const UNKNOWN = "Unknown member";

/** One person's name, given the roster they are being shown alongside. */
function labelFor(member: LabelledMember, ambiguous: ReadonlySet<string>): string {
  const name = member.name?.trim() ?? "";
  const email = member.email?.trim() ?? "";
  // No name at all: the address is the only thing left to call them, and it
  // needs no parenthetical because it is not disambiguating anything.
  if (!name) return email || UNKNOWN;
  if (!email || !ambiguous.has(name)) return name;
  return `${name} (${email})`;
}

/**
 * A naming function for one roster.
 *
 * Returns a function rather than taking the roster on every call so the
 * "which names are shared" pass happens once per list rather than once per
 * row, and so a caller cannot accidentally ask about a different roster than
 * the one being rendered.
 */
export function memberLabels(
  roster: readonly LabelledMember[],
): (member: LabelledMember) => string {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const m of roster) {
    const name = m.name?.trim();
    if (!name) continue;
    if (seen.has(name)) ambiguous.add(name);
    else seen.add(name);
  }
  return (member) => labelFor(member, ambiguous);
}
