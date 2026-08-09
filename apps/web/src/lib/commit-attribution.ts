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
export interface CommitAuthor {
  name: string;
  /**
   * Used for the trailer. GitHub links a co-author to an account by matching
   * this against the addresses on it, so a Specboards email that happens to be
   * their GitHub email links the commit to their profile; one that does not
   * still records the name in `git log`, which is the part that matters.
   */
  email: string;
}

/** What the write is doing, which decides the verb in the subject. */
export type SpecCommitAction = "update" | "create" | "remove";

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
 * Co-authored-by: Jane Doe <jane@acme.com>
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
}): string {
  const title = oneLine(input.title) || input.path;
  const verb = VERB[input.action];
  const subject = input.author
    ? `docs(spec): ${oneLine(input.author.name)} ${verb.withAuthor} ${title}`
    : `docs(spec): ${verb.plain} ${title}`;

  const lines = [subject, "", "Edited in Specboards.", input.path];
  if (input.author) {
    lines.push(
      "",
      `Co-authored-by: ${oneLine(input.author.name)} <${input.author.email}>`,
    );
  }
  return lines.join("\n");
}

/**
 * Resolve the acting user's name and email for attribution, or null.
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
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.email) return null;
    return { name: row.name?.trim() || row.email, email: row.email };
  } catch (err) {
    // Attribution is not worth failing a save over: the author would lose their
    // writing to protect a line in a commit message.
    console.warn("[commit-attribution] could not resolve the author:", err);
    return null;
  }
}
