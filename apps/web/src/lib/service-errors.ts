import { DomainError } from "@/lib/errors";

/**
 * The two errors every `/api/v1` domain service raises.
 *
 * They live on their own because sixteen of the seventeen modules in the layer
 * need them and nothing they need lives in the layer. Had a resource module
 * owned them instead, it would be imported by every one of its siblings, and
 * the first sibling it imported back would close a cycle.
 *
 * Note the neighbour: `@/lib/errors` defines `DomainError`, the rule about
 * which messages may cross a trust boundary. These are two concrete errors that
 * follow it. Read that file first if you are adding a third.
 */

export class FeatureNotFoundError extends DomainError {
  constructor(specId: string) {
    super(`Unknown feature: ${specId}`);
  }
}

export class InvalidPatchError extends DomainError {}
