/**
 * Can a service on the public internet reach this deployment?
 *
 * This exists because GitHub decides it for us. The App-manifest flow sends a
 * webhook URL, GitHub validates that it can deliver there, and refuses to
 * create the App at all when it cannot ("Hook url is not supported because it
 * isn't reachable over the public Internet"). It refuses the same way with the
 * hook marked inactive, and refuses a manifest with no hook URL as well, so
 * there is no manifest shape an unreachable instance can send. Knowing this up
 * front is what lets the UI offer the manual credential path instead of sending
 * the operator to a GitHub error page they cannot act on.
 *
 * Hostname-only and deliberately so: this decides which setup flow to offer,
 * not whether to trust a request target, so it needs no DNS resolution. The
 * SSRF guards in `lib/webhooks/ssrf.ts` and `lib/ai/egress.ts` are the ones
 * that resolve, because they are answering a security question. This is not.
 *
 * It errs toward "not reachable": a false negative offers the manual path to
 * someone who could have used one-click, which costs a little typing. A false
 * positive sends them to a GitHub error page, which is what we are fixing.
 */
export function isPubliclyReachable(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  // `new URL` keeps IPv6 literals in brackets; normalise so `::1` is comparable.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (bare === "localhost" || bare.endsWith(".localhost")) return false;
  // mDNS and the conventional internal-only suffix.
  if (bare.endsWith(".local") || bare.endsWith(".internal")) return false;
  // IPv6 loopback, and the unique-local (fc00::/7) and link-local (fe80::/10)
  // ranges, which are the v6 equivalents of the v4 blocks below.
  if (bare === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127) return false; // this-host, loopback
    if (a === 10) return false; // RFC1918
    if (a === 192 && b === 168) return false; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
    if (a === 169 && b === 254) return false; // link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, RFC6598
    return true;
  }

  // A dotless name is an intranet host (`specboards`, `buildserver`), never a
  // public FQDN. Checked after the IPv4 branch so an address is not caught by
  // it, and it tolerates a port having already been stripped by `new URL`.
  if (!bare.includes(".")) return false;

  return true;
}
