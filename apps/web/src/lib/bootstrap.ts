import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { bootstrapSecret, type Database } from "@specboards/db";

import { hasAnyUser } from "@/lib/first-run";

/**
 * Claiming a fresh instance.
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * A self-host with no mail transport cannot deliver a verification link, so
 * requiring one locked the operator out of the instance they had just
 * installed. PR #373 fixed that by dropping the requirement in exactly that
 * case. The consequence, which the card for this work predicted before either
 * change was made, is that a self-hosted instance reachable on the network
 * hands workspace-owner rights to whoever loads the sign-up page first.
 *
 * So the first account has to prove something. Not control of a mailbox, which
 * is the thing that may not exist, but possession of a secret that only
 * somebody who deployed the instance could have.
 *
 * ── Why it generates one rather than demanding configuration ────────────────
 * The other available shape was to refuse to start without an operator-supplied
 * token. That is simpler and it would undo the thing #373 was for: `docker
 * compose up` with no configuration at all is the documented install, and a
 * gate that breaks it trades one bricked first run for another. Generating a
 * token at first boot and printing it to the log is what GitLab and Grafana do
 * for the same reason.
 *
 * ── Scope, and why it needs no expiry ───────────────────────────────────────
 * The gate applies only while the deployment has no account at all. It is
 * asked with the same `hasAnyUser` the sign-up page already uses to decide
 * whether to call itself a first run, deliberately: two predicates for one
 * question is how a form comes to hide a field the server insists on. Once
 * anybody has signed up it is never consulted again, so there is nothing to
 * expire and nothing to replay.
 *
 * Hosted deployments are unaffected. They have accounts, so this is inert
 * there, and it stays inert without anybody having to remember a flag.
 */

/** How the deployment's first-run secret is supplied. */
export type BootstrapSource = "env" | "signup-code" | "generated";

/**
 * The operator-supplied secret, if there is one.
 *
 * `SPECBOARDS_SIGNUP_CODE` is accepted as well as the dedicated variable
 * because a deployment that has already set a sign-up code has already chosen
 * a secret for exactly this purpose, and making them set a second one to get
 * through the first screen would be ceremony. The dedicated variable wins when
 * both are present.
 */
export function configuredBootstrapToken(): {
  token: string;
  source: BootstrapSource;
} | null {
  const dedicated = process.env.SPECBOARDS_BOOTSTRAP_TOKEN?.trim();
  if (dedicated) return { token: dedicated, source: "env" };
  const signUp = process.env.SPECBOARDS_SIGNUP_CODE?.trim();
  if (signUp) return { token: signUp, source: "signup-code" };
  return null;
}

/** Whether the first-run gate applies to this request. */
export async function bootstrapRequired(db: Database): Promise<boolean> {
  return !(await hasAnyUser(db));
}

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Make sure this deployment has a first-run secret, and say what to tell the
 * operator.
 *
 * Returns the token itself only in the one case where the operator has no
 * other way to learn it: this process generated it just now. A token generated
 * by an earlier boot is not recoverable, by design, and the caller says so
 * rather than printing something that will not work.
 */
export async function ensureBootstrapSecret(db: Database): Promise<
  | { state: "configured"; source: BootstrapSource }
  | { state: "generated"; token: string }
  | { state: "already-generated" }
  | { state: "not-needed" }
> {
  if (await hasAnyUser(db)) return { state: "not-needed" };

  const configured = configuredBootstrapToken();
  if (configured) return { state: "configured", source: configured.source };

  const token = randomBytes(24).toString("base64url");
  // ON CONFLICT DO NOTHING, then check whether the insert was ours. Two
  // instances booting against the same fresh database would otherwise each
  // print a token, and only one of them would work: the singleton column makes
  // one insert win, and the loser has to say so rather than hand the operator
  // a secret the database has never seen.
  const inserted = await db
    .insert(bootstrapSecret)
    .values({ tokenHash: hash(token) })
    .onConflictDoNothing({ target: bootstrapSecret.singleton })
    .returning({ id: bootstrapSecret.id });

  return inserted.length > 0
    ? { state: "generated", token }
    : { state: "already-generated" };
}

/**
 * Does `provided` open the door?
 *
 * Always false for an empty submission, and always false when the deployment
 * somehow has no secret at all: with nothing to match, nothing should pass.
 * The generated-token path cannot reach that state, because the boot guard
 * creates the row before the app serves anything, and this is the layer under
 * that.
 */
export async function bootstrapSecretMatches(
  db: Database,
  provided: string,
): Promise<boolean> {
  const candidate = provided.trim();
  if (!candidate) return false;

  const configured = configuredBootstrapToken();
  if (configured) return digestsMatch(hash(candidate), hash(configured.token));

  const [row] = await db
    .select({ tokenHash: bootstrapSecret.tokenHash })
    .from(bootstrapSecret)
    .limit(1);
  if (!row) return false;
  return digestsMatch(hash(candidate), row.tokenHash);
}

/**
 * Boot-time: create the secret if needed and tell the operator how to use it.
 *
 * Loud on purpose, and only on a deployment that is actually unclaimed. This
 * is the one moment the token can be communicated at all, and an operator who
 * misses it has to go and read a table they cannot decrypt anything from.
 * Called from instrumentation.ts.
 */
export async function announceBootstrapSecret(db: Database): Promise<void> {
  try {
    const result = await ensureBootstrapSecret(db);
    if (result.state === "not-needed") return;

    if (result.state === "configured") {
      console.log(
        "[setup] This deployment has no accounts yet. The first sign-up must " +
          `present the ${
            result.source === "env"
              ? "SPECBOARDS_BOOTSTRAP_TOKEN"
              : "SPECBOARDS_SIGNUP_CODE"
          } you configured.`,
      );
      return;
    }
    if (result.state === "already-generated") {
      console.log(
        "[setup] This deployment has no accounts yet and a first-run token was " +
          "already generated by an earlier start. It is stored hashed and cannot " +
          "be shown again. Look in the log of the instance that generated it, or " +
          "set SPECBOARDS_BOOTSTRAP_TOKEN to a value of your choosing and restart.",
      );
      return;
    }

    console.log(
      "\n" +
        "  ┌─────────────────────────────────────────────────────────────┐\n" +
        "  │  Specboards first-run token                                 │\n" +
        "  └─────────────────────────────────────────────────────────────┘\n" +
        `      ${result.token}\n\n` +
        "  This deployment has no accounts yet. Enter the token above when you\n" +
        "  create the first account; that account administers the instance.\n" +
        "  It is shown once and stored hashed, so copy it now. To choose your\n" +
        "  own instead, set SPECBOARDS_BOOTSTRAP_TOKEN and restart.\n",
    );
  } catch (err) {
    // Never fail the boot over this. A deployment that cannot reach its
    // database has a larger problem, and the sign-up gate fails closed anyway:
    // with no secret stored, `bootstrapSecretMatches` admits nobody.
    console.error("[setup] could not prepare the first-run token:", err);
  }
}
