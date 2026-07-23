import { isMultiTenant } from "@/lib/tenancy";

/**
 * Boot-time validation of the deployment's canonical public origin (`APP_URL`,
 * falling back to `BETTER_AUTH_URL`). GitHub OAuth callbacks, webhook URLs,
 * App manifests, and MCP OAuth discovery are all built from this value.
 * Deriving it from forwarded headers instead would let a misconfigured or
 * hostile reverse proxy steer those security-sensitive URLs to an attacker's
 * host (host-header poisoning), so headers are treated as transport metadata
 * only.
 *
 * Contract mirrors the RLS guards in rls-guard.ts: multi-tenant fails closed,
 * single-tenant self-host warns and keeps booting. Called from
 * instrumentation.ts when the server starts.
 */

/** Hostnames that are legitimately served over plain HTTP in development. */
function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * The configured canonical origin (trailing slashes stripped), or null when
 * neither `APP_URL` nor `BETTER_AUTH_URL` is set.
 */
export function canonicalOrigin(): string | null {
  const configured = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

export function assertCanonicalOrigin(): void {
  // Local file mode with no GitHub App: nothing origin-sensitive is served.
  if (!process.env.DATABASE_URL && !process.env.GITHUB_APP_ID) return;

  const configured = canonicalOrigin();
  if (!configured) {
    const msg =
      "APP_URL (or BETTER_AUTH_URL) is not set. OAuth callback, webhook, and discovery " +
      "URLs would be derived from request headers, which a misconfigured or untrusted " +
      "proxy can spoof. Set APP_URL to this deployment's public origin.";
    if (isMultiTenant()) {
      throw new Error(`[security] Refusing to start: ${msg}`);
    }
    console.warn(`[security] ${msg}`);
    return;
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    // A configured-but-unparseable origin is a config error in any mode.
    throw new Error(
      `[security] Refusing to start: APP_URL/BETTER_AUTH_URL is not a valid URL: "${configured}".`,
    );
  }

  if (url.protocol !== "https:" && !isLocalHostname(url.hostname)) {
    const msg = `canonical origin "${configured}" is not HTTPS; OAuth flows over plain HTTP can be intercepted.`;
    if (isMultiTenant()) {
      throw new Error(`[security] Refusing to start: ${msg}`);
    }
    console.warn(`[security] ${msg}`);
    return;
  }

  console.log(`[security] canonical origin verified: ${configured}`);
}
