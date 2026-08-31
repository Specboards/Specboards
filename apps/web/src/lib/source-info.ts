/**
 * Canonical source, license, and version facts, surfaced in-app to satisfy the
 * AGPLv3 section 13 source-availability obligation (see `/legal`). Because
 * Specboards is AGPL-licensed, anyone who runs a modified copy and lets others
 * interact with it over a network must offer them its Corresponding Source; the
 * in-app "Source code" link and legal notice make that offer.
 */

/**
 * The repository the in-app notice points at. Defaults to the canonical
 * upstream, but a self-hoster running a MODIFIED copy should set
 * `NEXT_PUBLIC_SOURCE_REPO_URL` to their published fork so the AGPL section 13
 * offer resolves to their actual Corresponding Source.
 */
export const SOURCE_REPO_URL = (
  process.env.NEXT_PUBLIC_SOURCE_REPO_URL?.trim() ||
  "https://github.com/Specboards/Specboards"
).replace(/\/+$/, "");

/** Copyright holder and year, matching LICENSING.md / LICENSE. */
export const COPYRIGHT_HOLDER = "Studio Palouse";
export const COPYRIGHT_YEAR = "2026";

/** The license, as the in-app notice names and links it. */
export const LICENSE_NAME = "GNU Affero General Public License v3.0";
export const LICENSE_URL = `${SOURCE_REPO_URL}/blob/main/LICENSE`;

/**
 * The running commit, baked in at build time via the `NEXT_PUBLIC_GIT_SHA`
 * build arg (see infra/web.Dockerfile). Empty in local dev and any build that
 * doesn't pass it; callers fall back to the repo root.
 */
const GIT_SHA = (process.env.NEXT_PUBLIC_GIT_SHA ?? "").trim();

/** A human-facing version label: the commit when known, else "development". */
export function versionLabel(): string {
  return GIT_SHA || "development";
}

/**
 * A "Source code" link pinned to the running commit when known, so the offer
 * resolves to the exact Corresponding Source; otherwise the repository root.
 */
export function sourceUrl(): string {
  return GIT_SHA ? `${SOURCE_REPO_URL}/tree/${GIT_SHA}` : SOURCE_REPO_URL;
}
