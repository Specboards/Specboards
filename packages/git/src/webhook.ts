import { createHmac, timingSafeEqual } from "node:crypto";

import picomatch from "picomatch";

/** A normalized push event the sync engine cares about. */
export interface PushEvent {
  owner: string;
  name: string;
  /** Branch name with `refs/heads/` stripped. */
  ref: string;
  /** Paths added/modified/removed in the push. */
  changedPaths: string[];
}

/**
 * Verify a GitHub webhook HMAC signature (the `X-Hub-Signature-256` header,
 * formatted `sha256=<hex>`) against the App's webhook secret. Constant-time to
 * avoid leaking the expected digest. `payload` MUST be the exact raw request
 * body — re-serializing parsed JSON changes the bytes and breaks the HMAC.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so guard it (the length check
  // is not itself secret — both are fixed-width hex digests).
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Compile globs into a reusable matcher (avoids recompiling per path). */
export function compileGlobs(globs: string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  return picomatch(globs);
}

/** True if `path` matches any of `globs`. */
export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return compileGlobs(globs)(path);
}

/**
 * Decide which connected specs a push affects so the caller can re-parse only
 * those files and update `spec_index` (using `blobSha` to detect drift).
 */
export function affectedSpecs(event: PushEvent, globs: string[]): string[] {
  const matches = compileGlobs(globs);
  return event.changedPaths.filter((path) => matches(path));
}

/** Shape of the slice of a GitHub push webhook payload we read. */
interface GitHubPushPayload {
  ref?: string;
  repository?: {
    name?: string;
    owner?: { login?: string; name?: string };
  };
  commits?: Array<{ added?: string[]; removed?: string[]; modified?: string[] }>;
}

/**
 * Normalize a GitHub push webhook payload into a {@link PushEvent}. Returns
 * `null` for events we can't act on (non-branch refs, or missing repo coords).
 * `changedPaths` is the de-duplicated union of added/removed/modified across
 * every commit in the push.
 */
export function parsePushEvent(payload: unknown): PushEvent | null {
  const body = payload as GitHubPushPayload;
  const ref = body.ref;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return null;

  const owner = body.repository?.owner?.login ?? body.repository?.owner?.name;
  const name = body.repository?.name;
  if (!owner || !name) return null;

  const changed = new Set<string>();
  for (const commit of body.commits ?? []) {
    for (const path of [...(commit.added ?? []), ...(commit.removed ?? []), ...(commit.modified ?? [])]) {
      changed.add(path);
    }
  }

  return {
    owner,
    name,
    ref: ref.slice("refs/heads/".length),
    changedPaths: [...changed],
  };
}
