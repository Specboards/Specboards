import { isMultiTenant } from "@/lib/tenancy";

/**
 * Local file mode: no database, specs read straight off the working tree.
 *
 * It is a developer convenience, and it is **unauthenticated by construction**.
 * With no database there is no Better Auth and no membership to check, so the
 * authorization helpers in `auth-session.ts` return success for every request
 * and the store happily writes - including `LocalFileStore.deleteFeature`,
 * which removes a spec's Markdown file from the working tree.
 *
 * Until now the only thing selecting that mode was the *absence* of
 * `DATABASE_URL`. A deployment that lost its connection string, or never had
 * one, did not fail: it came up as an open, unauthenticated, file-deleting
 * server, and the production container binds `0.0.0.0`. Losing a secret should
 * break the app loudly, not quietly remove its front door.
 *
 * So local mode is now something you ask for. `SPECBOARDS_LOCAL_MODE=1` opts
 * in; without it, a missing `DATABASE_URL` is a startup failure. And opting in
 * is not enough on its own: the guard also refuses when the deployment looks
 * reachable from anywhere but this machine.
 *
 * Two layers on purpose. {@link assertLocalMode} fails the boot (and so a Fly
 * release, alongside the RLS and canonical-origin guards). {@link
 * isLocalFileMode} is checked per request, so even a process that somehow
 * started without the guard denies requests rather than authorizing them.
 */

/**
 * The opt-in: the flag (same truthy spellings as `SPECBOARDS_E2E`), or the
 * Next dev server.
 *
 * `NODE_ENV === "development"` is set by `next dev` and by nothing we deploy,
 * so `pnpm dev` with no database keeps working without ceremony. Note this is
 * the opposite direction to `lib/e2e.ts`, which cannot use NODE_ENV *because*
 * `next start` reports "production" for a local build: "development" is a
 * reliable signal that this is a dev server, while "production" says nothing
 * about whether the process is deployed. The loopback and origin checks below
 * still apply either way, so a dev server exposed on 0.0.0.0 is refused too.
 */
function localModeRequested(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  const value = process.env.SPECBOARDS_LOCAL_MODE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Hostnames that mean "this machine only". */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Whether this process is serving local file mode.
 *
 * Requires BOTH no `DATABASE_URL` and the explicit opt-in. A process missing
 * the database but not the flag is misconfigured, and reports `false` here so
 * the authorization helpers refuse the request instead of waving it through.
 */
export function isLocalFileMode(): boolean {
  return !process.env.DATABASE_URL && localModeRequested();
}

/**
 * Why local mode is not allowed here, or `null` when it is fine.
 *
 * Split out from {@link assertLocalMode} so the same reasoning can be asserted
 * in tests without catching thrown errors.
 */
export function localModeRefusal(): string | null {
  if (process.env.DATABASE_URL) return null;

  if (isMultiTenant()) {
    return (
      "SPECBOARDS_MULTI_TENANT is set but DATABASE_URL is not. A hosted, " +
      "multi-tenant deployment cannot run on the local file store, which has " +
      "no accounts and no tenant boundary at all."
    );
  }

  if (!localModeRequested()) {
    return (
      "DATABASE_URL is not set. Specboards will not fall back to the " +
      "unauthenticated local file store on its own: with no database there is " +
      "no sign-in and no membership check, so every request would be " +
      "authorized, including deleting spec files. Set DATABASE_URL, or set " +
      "SPECBOARDS_LOCAL_MODE=1 if you really do want the local, " +
      "single-developer file store."
    );
  }

  // Opted in. Now check it cannot be reached from another machine. NODE_ENV is
  // no help: `next start` reports "production" for a local build too (the same
  // reason `lib/e2e.ts` keys off the origin instead).
  const bind = process.env.HOSTNAME?.trim();
  if (bind && !isLoopbackHost(bind)) {
    return (
      `SPECBOARDS_LOCAL_MODE is set but the server binds ${bind}, which other ` +
      "machines can reach. Local file mode has no authentication, so it must " +
      "listen on loopback only: set HOSTNAME=127.0.0.1, or set DATABASE_URL " +
      "and run the real thing."
    );
  }

  const origin = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  if (origin) {
    let hostname: string;
    try {
      ({ hostname } = new URL(origin));
    } catch {
      return `APP_URL/BETTER_AUTH_URL is not a valid URL: "${origin}".`;
    }
    if (!isLoopbackHost(hostname)) {
      return (
        `SPECBOARDS_LOCAL_MODE is set but this deployment serves ${origin}, a ` +
        "public origin. Local file mode has no authentication and must not be " +
        "served beyond this machine."
      );
    }
  }

  return null;
}

/**
 * Boot guard. Called from `instrumentation.ts`, so a misconfigured deployment
 * fails its release rather than taking traffic (Fly keeps the previous version
 * serving). Mirrors the contract of the RLS and canonical-origin guards, except
 * that this one has no warn-and-continue path: there is no mode in which
 * serving unauthenticated writes to an open port is acceptable.
 */
export function assertLocalMode(): void {
  const refusal = localModeRefusal();
  if (refusal) {
    throw new Error(`[security] Refusing to start: ${refusal}`);
  }
  if (isLocalFileMode()) {
    console.warn(
      "[security] local file mode: no database, NO AUTHENTICATION, loopback " +
        "only. Every request is authorized, including spec file deletion. " +
        "Never expose this process.",
    );
  }
}
