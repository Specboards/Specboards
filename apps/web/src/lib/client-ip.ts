/**
 * Who the client is, for rate limiting, and when that answer can be trusted.
 *
 * Every header that names a client IP is written by something upstream, so the
 * question is never "what does the header say" but "who put it there".
 *
 * - `fly-client-ip` is set by Fly's proxy at its edge and **overwrites**
 *   anything the client sent, so on a Fly deployment it is authoritative. This
 *   is already why `lib/auth.ts` prefers it: without it the socket peer is the
 *   edge, and Better Auth's limiter collapses to one shared bucket for every
 *   visitor (observed on production).
 *
 *   It is only authoritative *on Fly*, though, and that was the gap: this
 *   header used to be trusted unconditionally, while `x-forwarded-for` required
 *   an explicit opt-in. On a self-host outside Fly nothing overwrites it, so a
 *   caller got a fresh rate-limit bucket per request by varying one header, and
 *   the limit read as per-IP while providing none. It is now gated on
 *   {@link onFly}, which reads an environment variable the Fly runtime sets and
 *   a request cannot.
 * - `x-forwarded-for` is appended to, not overwritten, by most proxies, and on
 *   a deployment with no normalising proxy at all it is simply whatever the
 *   client typed. Trusting it there lets a caller mint a fresh rate-limit
 *   bucket per request by varying one header, which is the same as having no
 *   per-IP limit while looking like you have one.
 *
 * So `x-forwarded-for` is used only when the operator says a proxy normalises
 * it (`SPECBOARDS_TRUST_PROXY=1`). Otherwise the client is `unknown`, and
 * callers are expected to fall back to a stricter shared limit rather than
 * pretend they can tell visitors apart.
 */

type ClientIp =
  | { known: true; ip: string; source: "fly-client-ip" | "x-forwarded-for" }
  | { known: false };

/**
 * Whether this process is running on Fly.
 *
 * `FLY_APP_NAME` is injected into the machine's environment by the Fly runtime.
 * A request cannot set it, which is exactly the property needed here: the
 * question "is there a proxy in front of me that overwrites `fly-client-ip`"
 * has to be answered by the deployment, not by the caller.
 *
 * Deliberately not configurable. An operator who genuinely fronts the app with
 * something that normalises a forwarded header has `SPECBOARDS_TRUST_PROXY` and
 * `x-forwarded-for`, which is the documented route; adding a second switch that
 * says "believe this other header too" would be a way to reintroduce the bug.
 */
export function onFly(): boolean {
  return Boolean(process.env.FLY_APP_NAME?.trim());
}

/** Whether a proxy in front of this deployment normalises `x-forwarded-for`. */
export function trustsForwardedFor(): boolean {
  const value = process.env.SPECBOARDS_TRUST_PROXY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Resolve the client IP under the trust model above. `known: false` means no
 * header we are willing to believe, not that the request had no headers.
 */
export function clientIp(req: Request): ClientIp {
  if (onFly()) {
    const fly = req.headers.get("fly-client-ip")?.trim();
    if (fly) return { known: true, ip: fly, source: "fly-client-ip" };
  }

  if (trustsForwardedFor()) {
    // Left-most entry is the original client when a trusted proxy appends.
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return { known: true, ip: forwarded, source: "x-forwarded-for" };
  }

  return { known: false };
}

/**
 * A rate-limit bucket key for `req`, prefixed with `scope`.
 *
 * When the client cannot be identified, every caller shares one bucket named
 * `<scope>:unknown-client`. That is deliberately blunt: a shared bucket
 * throttles everyone during abuse, which is worse for legitimate users than
 * per-IP limiting but far better than an unbounded endpoint, and it cannot be
 * escaped by forging a header. The alternative - trusting an unverifiable
 * header - reads as a per-IP limit while providing none.
 */
export function rateLimitKey(req: Request, scope: string): string {
  const client = clientIp(req);
  return client.known ? `${scope}:${client.ip}` : `${scope}:unknown-client`;
}
