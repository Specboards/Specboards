import { createHash } from "node:crypto";

import { eq, users, type Database } from "@specboards/db";

/**
 * Putting the author's name on a spec commit.
 *
 * Spec writes go through the GitHub App installation token, so every commit in
 * the repo is authored by "Specboards". Once several people are writing specs,
 * `git log` stops answering "who changed this requirement, and when did they
 * decide that?" That question is most of the value of keeping specs in git, and
 * it is the one an engineer asks when a spec contradicts the code.
 *
 * A `Co-authored-by` trailer is the fallback in name only. It is the common
 * path: the non-technical authors this initiative exists for are the least
 * likely to have a GitHub account, which is much of the point of the product.
 * So the trailer has to carry the attribution properly on its own, not act as a
 * degraded version of something better.
 *
 * The subject matters as much as the trailer. A repo full of
 * `docs(specboard): update specs/refunds/spec.md` tells a reviewer scanning
 * `git log --oneline` nothing at all: not who, not what, not why they should
 * care. Naming the person and the spec is what makes the history readable
 * without opening every commit.
 */

/** Who to credit, resolved from the acting user. */
interface CommitAuthor {
  name: string;
  /**
   * A minted, non-routable address, never the user's real one.
   *
   * The trailer format requires `Name <email>`: an address is structurally
   * mandatory, so the choice is which one, not whether. Using the real one
   * would publish a person's email into a repository that is often public and
   * always outside our control, and a commit cannot be unpublished. That is a
   * disclosure the author never agreed to in exchange for a line in a log.
   *
   * What it costs is profile linking, and less than it appears: GitHub only
   * ever linked a co-author whose Specboards address happened to also be on
   * their GitHub account. Those are precisely the people who will connect an
   * account and get genuine authorship from their own token, at which point
   * there is no trailer at all. The name is what makes `git log` answer the
   * question, and the name is unaffected.
   *
   * GitHub solves the same problem the same way with
   * `users.noreply.github.com`.
   */
  email: string;
}

/**
 * Domain for minted attribution addresses. Must never accept mail: nothing
 * should be deliverable here, and a stray MX record would turn a privacy
 * measure into a mailbox.
 */
const NOREPLY_DOMAIN = "users.noreply.specboards.ai";

/**
 * A stable, non-routable address for an author.
 *
 * The name is already in the trailer, so the readable slug discloses nothing
 * further; the digest is what keeps two people called Jane Doe apart and keeps
 * one person's commits grouped as theirs over time. Derived from the user id
 * rather than being the id, so an internal identifier is not published either.
 */
export function attributionAddress(userId: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "author";
  const tag = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `${slug}-${tag}@${NOREPLY_DOMAIN}`;
}

/** What the write is doing, which decides the verb in the subject. */
type SpecCommitAction = "update" | "create" | "remove";

const VERB: Record<SpecCommitAction, { withAuthor: string; plain: string }> = {
  update: { withAuthor: "updated", plain: "update" },
  create: { withAuthor: "added", plain: "add" },
  remove: { withAuthor: "removed", plain: "remove" },
};

/**
 * A commit message's subject has to survive `git log --oneline`, so anything
 * that would break it out of one line is flattened rather than passed through.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Build the commit message for a spec write.
 *
 * Shape:
 *
 * ```
 * docs(spec): Jane Doe updated Refund policy
 *
 * Edited in Specboards.
 * specs/refunds/spec.md
 *
 * Co-authored-by: Jane Doe <jane-doe-8f3a2b1c@users.noreply.specboards.ai>
 * ```
 *
 * With `assistantDrafted`, the same shape with the provenance changed:
 *
 * ```
 * docs(spec): Jane Doe accepted an assistant edit to Refund policy
 *
 * Drafted by the Specboards assistant and accepted by a person.
 * specs/refunds/spec.md
 *
 * Co-authored-by: Jane Doe <jane-doe-8f3a2b1c@users.noreply.specboards.ai>
 * ```
 *
 * The path moves into the body because the title is the useful identifier for
 * a reader and the path is the useful one for a tool; putting the path in the
 * subject spends the only line most people read on the less useful of the two.
 */
export function specCommitMessage(input: {
  action: SpecCommitAction;
  /** The spec's human title. */
  title: string;
  /** Repo-relative path of the file being written. */
  path: string;
  /** Null when the write has no attributable person (sync, an automation). */
  author: CommitAuthor | null;
  /**
   * True when the text was drafted by the assistant and a person accepted it.
   *
   * The card this implements asks that someone reading a requirement in six
   * months can tell which it was, and `git log` is where they will look. A
   * commit that says "Jane updated Refund policy" when Jane read a diff and
   * clicked accept is not false so much as unanswerable: it gives the reader no
   * way to know a model wrote the words. So the verb changes, and the body
   * says so outright.
   *
   * The trailer does not change. Jane is still the person accountable for the
   * requirement; crediting the model as an author would attribute a decision to
   * something nobody can ask about it afterwards.
   */
  assistantDrafted?: boolean;
}): string {
  const title = oneLine(input.title) || input.path;
  const verb = VERB[input.action];
  const what = input.assistantDrafted ? `an assistant edit to ${title}` : title;
  const subject = input.author
    ? `docs(spec): ${oneLine(input.author.name)} ${
        input.assistantDrafted ? "accepted" : verb.withAuthor
      } ${what}`
    : `docs(spec): ${input.assistantDrafted ? "accept" : verb.plain} ${what}`;

  const provenance = input.assistantDrafted
    ? "Drafted by the Specboards assistant and accepted by a person."
    : "Edited in Specboards.";
  const lines = [subject, "", provenance, input.path];
  if (input.author) {
    lines.push(
      "",
      `Co-authored-by: ${oneLine(input.author.name)} <${input.author.email}>`,
    );
  }
  return lines.join("\n");
}

/**
 * Resolve who to credit, or null.
 *
 * Reads the display name only. The user's email is deliberately never loaded:
 * the address in the trailer is minted, so there is no point at which a real
 * one is in hand and could be written out by mistake.
 *
 * Null rather than a placeholder: a commit credited to "Unknown
 * <unknown@example.com>" is worse than one that simply carries no co-author,
 * because it looks like an answer.
 */
export async function resolveCommitAuthor(
  db: Database,
  userId: string | null | undefined,
): Promise<CommitAuthor | null> {
  if (!userId) return null;
  try {
    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    // A blank display name must not fall back to the email: that is the one
    // value this whole change exists to keep out of the repo.
    const name = row.name?.trim() || "Specboards user";
    return { name, email: attributionAddress(userId, name) };
  } catch (err) {
    // Attribution is not worth failing a save over: the author would lose their
    // writing to protect a line in a commit message.
    console.warn("[commit-attribution] could not resolve the author:", err);
    return null;
  }
}
