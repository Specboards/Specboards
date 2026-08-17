import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent } from "undici";

/**
 * Where "may the server call this address" is decided, for every feature that
 * takes a URL from a customer and then fetches it.
 *
 * This started as the webhook SSRF guard and was promoted here when model
 * provider connections needed the same discipline. It is deliberately one
 * implementation rather than two: the classification is subtle (IPv4-mapped
 * IPv6, 6to4, Teredo, CGNAT, the 169.254.169.254 metadata address) and a second
 * copy would drift from this one silently, which is the failure mode that makes
 * SSRF bugs expensive.
 *
 * What is NOT shared is the *policy*: whether a given feature may reach a
 * private address at all. Webhooks and model endpoints answer that differently,
 * because a self-hosted model is on a private address by definition while a
 * webhook target has no such excuse. So {@link resolveTarget} takes
 * `allowPrivate` as an argument and reads no environment itself; each caller
 * owns its own flag and its own boot guard.
 *
 * Address classification uses the maintained `ipaddr.js` range parser rather
 * than hand-rolled range math.
 */

export type UrlCheck = { ok: true } | { ok: false; reason: string };

/** A resolved, validated address to pin a connection to. */
export interface PinnedAddress {
  address: string;
  /** 4 or 6, as reported by DNS resolution / literal parsing. */
  family: 4 | 6;
}

export type TargetResolution =
  | { ok: true; addresses: PinnedAddress[] }
  | { ok: false; reason: string };

/** Allow only global unicast IPv4; block every special-use range. */
function isBlockedIpv4Range(addr: ipaddr.IPv4): boolean {
  // ipaddr.js "unicast" is the only globally-routable class. `private`,
  // `loopback`, `linkLocal`, `carrierGradeNat`, `broadcast`, `multicast`,
  // `reserved`, and `unspecified` are all rejected.
  return addr.range() !== "unicast";
}

/**
 * True if `ip` (v4 or v6 literal) is one we must never call out to. Only
 * globally-routable unicast is allowed; everything else (loopback, private,
 * link-local incl. the 169.254.169.254 metadata IP, unique-local, CGNAT,
 * multicast, reserved, unspecified) is blocked. IPv4-mapped IPv6 is unwrapped
 * and judged as its embedded IPv4, and transitional embeddings (6to4/Teredo)
 * are blocked outright since no outbound integration needs them.
 */
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true; // unparseable → treat as blocked
  }

  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      // e.g. ::ffff:127.0.0.1 or its hex form ::ffff:7f00:1 — judge the v4.
      return isBlockedIpv4Range(v6.toIPv4Address());
    }
    // Only global unicast v6 is allowed; everything else (incl. 6to4/teredo,
    // which embed addresses we don't want to reach) is blocked.
    return v6.range() !== "unicast";
  }

  return isBlockedIpv4Range(addr as ipaddr.IPv4);
}

/**
 * Validate a target URL and resolve it to the concrete address(es) a connection
 * may use: HTTPS only, well-formed, and neither a literal non-global IP nor a
 * hostname that resolves to one (every A/AAAA record is checked; a single
 * private answer fails the whole set). Returns the validated addresses so the
 * caller can pin the connection to exactly what was checked.
 *
 * With `allowPrivate` every check is skipped, including the HTTPS requirement,
 * and no addresses are returned so the caller connects normally. That mode is
 * for deployments that have deliberately opted into reaching their own network;
 * deciding whether a caller qualifies is the caller's job, not this function's.
 */
export async function resolveTarget(
  raw: string,
  { allowPrivate }: { allowPrivate: boolean },
): Promise<TargetResolution> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    return { ok: false, reason: "The URL must use https." };
  }
  if (allowPrivate) return { ok: true, addresses: [] };

  const host = url.hostname;

  // Literal IP host: validate directly, no DNS.
  const literal = isIP(host);
  if (literal) {
    if (isBlockedIp(host)) {
      return { ok: false, reason: "URL points at a private or reserved address." };
    }
    return { ok: true, addresses: [{ address: host, family: literal === 4 ? 4 : 6 }] };
  }

  // Hostname: resolve and reject if ANY resolved address is blocked.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "Could not resolve the host." };
  }
  if (addrs.length === 0) return { ok: false, reason: "Host did not resolve." };
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      return { ok: false, reason: "Host resolves to a private or reserved address." };
    }
  }
  return {
    ok: true,
    addresses: addrs.map((a) => ({
      address: a.address,
      family: a.family === 6 ? 6 : 4,
    })),
  };
}

/**
 * An undici dispatcher whose DNS lookup always returns the pre-validated
 * address(es), never re-resolving. This is what closes the DNS-rebinding gap:
 * undici connects to what we already checked, not to a fresh lookup made a
 * moment later, by which time the record may point somewhere private. TLS SNI
 * and certificate validation still use the original hostname.
 *
 * The caller owns the returned agent and must `close()` it.
 */
export function pinnedAgent(addresses: PinnedAddress[], timeoutMs: number): Agent {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup(_hostname, options, callback) {
        if (options && options.all) {
          callback(null, addresses as never);
        } else {
          const first = addresses[0]!;
          // dns.lookup callback shape when `all` is false.
          (callback as (e: Error | null, a: string, f: number) => void)(
            null,
            first.address,
            first.family,
          );
        }
      },
    },
  });
}
