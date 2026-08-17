import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";

/**
 * Trusting a private certificate authority for the model endpoint, and nothing
 * else.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * An on-prem customer's inference runs behind a certificate issued by their own
 * internal CA, or by nothing at all (a self-signed cert). Node trusts neither,
 * so the very first call fails with `unable to verify the first certificate` or
 * `self-signed certificate` and the connection looks broken when it is
 * correctly configured. This is the single most likely thing to break in an
 * air-gapped deployment, which is why it is handled rather than left to the
 * operator to discover.
 *
 * ── Why not the two obvious workarounds ─────────────────────────────────────
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` turns off certificate verification for the
 * entire process, which means webhook deliveries, GitHub and outbound email
 * too. It is a way to make one endpoint work by making every other one
 * unsafe, so it is never the right answer here.
 *
 * `NODE_EXTRA_CA_CERTS` is much better and does work, but it is also
 * process-wide and has to be set before Node starts, which makes it awkward on
 * platforms where the entrypoint is not yours to edit. This variable is scoped
 * to the model dispatcher, is read at request time, and can be a value rather
 * than a mounted file.
 *
 * ── Self-signed is the same case ────────────────────────────────────────────
 * A self-signed certificate is its own authority, so pointing this at the
 * certificate itself is exactly how you trust it. That is why there is no
 * "skip verification" switch: every case the card names is served by adding
 * trust, and a switch that removed it would be reached for far more often than
 * it was needed.
 */

/** The variable an operator sets: inline PEM, or a path to a PEM file. */
const ENV = "SPECBOARDS_MODEL_CA_CERT";

/** Read once. A cert does not change under a running process, and re-reading
 * a file on every model call would put disk I/O on the inference path. */
let cached: { value: string | undefined } | null = null;

function looksLikePem(value: string): boolean {
  return value.includes("-----BEGIN CERTIFICATE-----");
}

/** Read the configured certificate, or throw with something actionable. */
function load(): string | undefined {
  const raw = process.env[ENV]?.trim();
  if (!raw) return undefined;

  // Inline PEM, for platforms where a secret is easier to set than a file to
  // mount. Newlines survive Fly secrets and Docker env files intact.
  if (looksLikePem(raw)) return raw;

  let contents: string;
  try {
    contents = readFileSync(raw, "utf8");
  } catch (err) {
    throw new Error(
      `${ENV} is set to "${raw}", which is neither PEM text nor a readable ` +
        `file: ${err instanceof Error ? err.message : "read failed"}. Point it ` +
        `at your CA certificate, or paste the PEM in directly.`,
    );
  }
  if (!looksLikePem(contents)) {
    throw new Error(
      `${ENV} points at "${raw}", which was read but contains no certificate. ` +
        `Expected a PEM file beginning with -----BEGIN CERTIFICATE-----.`,
    );
  }
  return contents;
}

/**
 * The `ca` value for the model dispatcher's TLS options, or undefined when no
 * private authority is configured and Node's defaults are correct.
 *
 * Node's public roots are included alongside the private one. Passing `ca`
 * *replaces* the default store rather than extending it, so returning the
 * custom cert alone would quietly break a workspace pointed at a hosted
 * provider the moment an operator configured an internal CA for a different
 * one. Trust is meant to be additive here.
 */
export function modelCaBundle(): string[] | undefined {
  cached ??= { value: load() };
  if (!cached.value) return undefined;
  return [...rootCertificates, cached.value];
}

/** Test seam: the cache is process-wide and would otherwise leak between cases. */
export function resetModelCaCache(): void {
  cached = null;
}

/**
 * Boot guard, called from `instrumentation.ts`. A mistyped path or a file that
 * is not a certificate should stop the release, not surface as "could not reach
 * the model endpoint" on the first call somebody makes in the settings screen.
 */
export function assertModelTlsConfig(): void {
  resetModelCaCache();
  const bundle = modelCaBundle();
  if (bundle) {
    console.warn(
      `[security] ${ENV} is set: the model endpoint may present a certificate ` +
        `from a private authority. Public roots remain trusted.`,
    );
  }
}
