import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

/**
 * SSRF guard for user-supplied webhook URLs. On a hosted multi-tenant app the
 * endpoint URL is attacker-controllable, so a naive `fetch` is a server-side
 * request forgery primitive: it could hit the cloud metadata IP, internal
 * services, or loopback. We require HTTPS, reject any host that is (or resolves
 * to) a non-global address, and the sender pins the TCP connection to the exact
 * address we validated (see `resolveValidatedTarget` + sender.ts) so DNS can't
 * rebind to a private target between validation and connect.
 *
 * Address classification uses the maintained `ipaddr.js` range parser rather
 * than hand-rolled range math, so hex/compressed IPv6, IPv4-mapped IPv6 (in
 * any notation), 6to4, and Teredo forms are all covered.
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

/**
 * True if `ip` (v4 or v6 literal) is one we must never call out to. Only
 * globally-routable unicast is allowed; everything else (loopback, private,
 * link-local incl. the 169.254.169.254 metadata IP, unique-local, CGNAT,
 * multicast, reserved, unspecified) is blocked. IPv4-mapped IPv6 is unwrapped
 * and judged as its embedded IPv4, and transitional embeddings (6to4/Teredo)
 * are blocked outright since a webhook never needs them.
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

/** Allow only global unicast IPv4; block every special-use range. */
function isBlockedIpv4Range(addr: ipaddr.IPv4): boolean {
  const range = addr.range();
  // ipaddr.js "unicast" is the only globally-routable class. `private`,
  // `loopback`, `linkLocal`, `carrierGradeNat`, `broadcast`, `multicast`,
  // `reserved`, and `unspecified` are all rejected.
  return range !== "unicast";
}

/**
 * Validate a webhook target URL and resolve it to the concrete address(es) a
 * connection may use: HTTPS only, well-formed, and neither a literal non-global
 * IP nor a hostname that resolves to one (every A/AAAA record is checked; a
 * single private answer fails the whole set). Returns the validated addresses
 * so the caller can pin the connection to exactly what was checked.
 *
 * In `SPECBOARD_WEBHOOK_ALLOW_PRIVATE` mode (self-host / e2e) all checks are
 * skipped and no addresses are returned, so the sender connects normally.
 */
export async function resolveValidatedTarget(raw: string): Promise<TargetResolution> {
  const allowPrivate = process.env.SPECBOARD_WEBHOOK_ALLOW_PRIVATE === "1";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    return { ok: false, reason: "Webhook URLs must use https." };
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
 * Validate a webhook target URL (HTTPS + not private/reserved). Thin wrapper
 * over {@link resolveValidatedTarget} for callers that only need a yes/no at
 * save time (see webhooks-service). The delivery path uses the resolved
 * addresses directly to pin the connection.
 */
export async function assertPublicUrl(raw: string): Promise<UrlCheck> {
  const result = await resolveValidatedTarget(raw);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
