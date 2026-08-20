import { sql, type Database } from "@specboards/db";

/** A Drizzle transaction handle, as `Database["transaction"]` hands one over. */
export type ScopedTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run `fn` as `userId`, on the RLS-enforced connection.
 *
 * Row-level security keys on the `app.user_id` setting, which
 * `specboards_is_member` and friends read. The setting is transaction-local
 * (the third argument to `set_config`), so it has to live inside a transaction:
 * that is what makes it safe on a pooled connection, where the next statement
 * may belong to somebody else entirely. Setting it at session level would leak
 * one request's identity into the next.
 *
 * ── Per operation, never around a model stream ──────────────────────────────
 * Every call here should wrap one short clump of queries. It must NOT wrap a
 * model response: an assistant turn can stream for minutes, and a transaction
 * held open across it pins a connection, blocks vacuum on the tables it touched,
 * and turns one slow endpoint into a pool outage. The services this supports are
 * written so their database work sits in clumps before and after the stream,
 * which is what makes that easy to honour. If a change here starts to need a
 * transaction spanning a stream, the change is wrong, not this rule.
 *
 * ── What happens if you forget ──────────────────────────────────────────────
 * Queries made on `getAppDb()` outside this helper run with no `app.user_id`,
 * so every policy predicate is false: reads return nothing and writes are
 * refused. That fails closed, which is the right direction, but it looks like
 * data loss rather than a mistake, so it is worth recognising.
 */
export async function asUser<T>(
  db: Database,
  userId: string,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  if (!userId) {
    // An empty id would set the variable to '' and match no member, so every
    // read would come back empty and every write would be refused, which reads
    // as a data problem rather than a bug in the caller. Fail where the mistake
    // is instead.
    throw new Error("asUser requires an acting user id.");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
