/**
 * Single- vs multi-tenant mode.
 *
 * The app is *always* multi-tenant internally — the active org is resolved and
 * validated against the caller's memberships on every request (see
 * `resolveActiveWorkspace`). This flag only governs whether one deployment
 * serves many orgs (hosted) or exactly one (self-host).
 *
 * Default is **single-tenant** so the OSS / self-host path is the simple one;
 * hosted opts in with `SPECBOARDS_MULTI_TENANT=true`. Single-tenant is just the
 * N=1 case of the same code path — never a fork.
 *
 * See docs/adr/0001-multi-tenancy-url-and-product-grouping.md (D1).
 */
export function isMultiTenant(): boolean {
  return process.env.SPECBOARDS_MULTI_TENANT === "true";
}

/** Convenience inverse of {@link isMultiTenant}. */
export function isSingleTenant(): boolean {
  return !isMultiTenant();
}

/**
 * Whether this deployment has *declared itself* a self-host.
 *
 * Distinct from {@link isSingleTenant}, and deliberately so. Single-tenant is
 * the default: it is what you get by not setting anything, so it describes
 * every misconfigured deployment as well as every real self-host. That makes it
 * the wrong thing to key a security decision on, because the failure mode is
 * silent and points the wrong way — forget a variable on a hosted deployment
 * and it starts looking like a self-host.
 *
 * This is opt-in, set by `infra/docker-compose.yml` for the stack we ship. A
 * deployment that has not said it is a self-host is treated as one that is not,
 * so the safe branch is the default and the relaxed branch has to be asked for.
 */
export function isSelfHost(): boolean {
  return process.env.SPECBOARDS_SELF_HOST === "true";
}
