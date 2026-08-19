/**
 * The base class for an error whose message was written to be read by whoever
 * made the call.
 *
 * This exists to answer one question at a trust boundary: may this error's text
 * be handed to the caller? Our own domain errors ("No item with spec id X.",
 * "status must be a non-empty string.") are written for exactly that and are
 * useless if replaced by something generic. An error from a library is the
 * opposite: it is written for whoever is holding a stack trace, and it freely
 * quotes internals. Drizzle's `DrizzleQueryError` is the sharpest example, since
 * its message is the failing SQL statement and every bound parameter.
 *
 * Before this, both kinds were a bare `Error` and nothing downstream could tell
 * them apart, so `/api/mcp` returned whichever it caught. That leaked the schema
 * and the workspace id to any connected agent that sent a malformed argument.
 *
 * The rule is therefore: extend this when the message is for the caller, and a
 * boundary may surface it. Anything that does not extend it is treated as
 * internal and replaced with a reference id. Getting that backwards for a new
 * error class costs a vaguer message, never a disclosure, which is the right
 * direction for the mistake to fall.
 */
export class DomainError extends Error {}

/** True when `err`'s message was written for a caller and may be surfaced. */
export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
