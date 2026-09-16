/**
 * How a failed migration is reported to whoever is reading the deploy log.
 *
 * Its own module so it can be tested. `migrate.ts` calls `main()` at import
 * time, by design: it is a script, not a library. That makes importing it from
 * a test the same thing as running a migration, which is why this lives here
 * rather than being exported from there.
 */

/**
 * A failure whose message is written for the operator reading the deploy log.
 *
 * The distinction matters because {@link describe} deliberately keeps only the
 * first line of an error. That is right for a driver error, where line one is
 * the summary and the useful parts arrive separately in `detail` and `hint`,
 * and it is wrong for one we wrote, where the message IS the procedure.
 *
 * The squashed-baseline failure is the case that proved it. It composes ten
 * lines explaining what happened and how to recover, and what reached the
 * container log was:
 *
 *     [migrate] failed: This database has applied migrations but is behind the squashed baseline,
 *
 * ending in a comma, with every word of recovery guidance removed. A
 * self-hoster hitting the one error most likely to stop an upgrade was told
 * nothing about how to get out of it.
 */
export class MigrationGuidance extends Error {
  constructor(lines: readonly string[]) {
    super(lines.join("\n"));
    this.name = "MigrationGuidance";
  }
}

/** Longest slice of a failed statement worth printing. */
const QUERY_EXCERPT = 400;

/**
 * A failure report that leads with the reason.
 *
 * Two things made the original one useless at the moment it mattered. Drizzle
 * wraps a failed migration in an error whose *message is the entire SQL file*
 * and whose `cause` holds the only sentence that says what Postgres objected
 * to, so printing `err.stack` gave four thousand lines of echoed schema and no
 * reason. And `process.exit()` does not wait for a pending `stderr` write, so
 * that flood was then truncated part-way through, taking the cause with it.
 *
 * So: the cause first, the Postgres fields next, and the failing statement last
 * and clipped. The process sets an exit code and ends on its own, which lets
 * the write drain.
 *
 * The clipping is per error rather than blanket, and {@link MigrationGuidance}
 * is the exception: a message we composed for an operator survives whole, a
 * driver's does not. Getting that backwards is how the squashed-baseline
 * failure came to report a sentence ending in a comma.
 */
export function describe(err: unknown): string {
  const lines: string[] = [];
  const causes: string[] = [];

  let current: unknown = err;
  let depth = 0;
  while (current instanceof Error && depth < 5) {
    const pg = current as {
      message: string;
      code?: string;
      detail?: string;
      hint?: string;
      position?: string;
      cause?: unknown;
    };
    if (current instanceof MigrationGuidance) {
      // Whole, never clipped. This message was written to be read by the
      // person whose upgrade just stopped, and its last paragraph is the only
      // part that tells them what to do next.
      causes.push(pg.message);
    } else if (depth > 0 || !pg.message.startsWith("Failed query:")) {
      // First line only, which is the right call for a driver error: Postgres
      // puts the summary on line one and the parts worth reading in `detail`
      // and `hint`, which are picked up separately just below.
      causes.push(pg.message.split("\n")[0] ?? pg.message);
    }
    const fields = [
      pg.code ? `code ${pg.code}` : null,
      pg.detail ? `detail: ${pg.detail}` : null,
      pg.hint ? `hint: ${pg.hint}` : null,
      pg.position ? `position: ${pg.position}` : null,
    ].filter(Boolean);
    if (fields.length > 0) causes.push(`  ${fields.join(", ")}`);
    current = pg.cause;
    depth++;
  }

  lines.push(causes.length > 0 ? causes.join("\n") : String(err));

  if (err instanceof Error && err.message.startsWith("Failed query:")) {
    const query = err.message.slice("Failed query:".length).trim();
    const excerpt =
      query.length > QUERY_EXCERPT
        ? `${query.slice(0, QUERY_EXCERPT)}\n  … (${query.length} chars total)`
        : query;
    lines.push(`while running:\n${excerpt}`);
  }
  return lines.join("\n");
}

