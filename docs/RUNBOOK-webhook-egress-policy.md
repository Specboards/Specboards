# RUNBOOK: out-of-app egress policy for webhook SSRF

Backlog card: "Out-of-app egress policy for webhook SSRF" (Security & platform
hardening epic). This is the **defense-in-depth** platform control that sits on
top of the in-code SSRF guard. The in-code layer already ships and meets the
card's acceptance criteria on its own; this runbook is the belt-and-braces
egress control for the case where that code is ever bypassed by a bug.

## What already ships (in-code, done)

`apps/web/src/lib/webhooks/ssrf.ts` + `sender.ts`:

- HTTPS-only, `redirect: "manual"` (no redirect-based rebind).
- Every candidate host is resolved and each address classified with
  `ipaddr.js`; anything that is not globally-routable unicast is rejected
  (loopback, RFC1918 private, link-local incl. the `169.254.169.254` metadata
  IP, unique-local, CGNAT, multicast, reserved, unspecified). IPv4-mapped IPv6
  (decimal and hex) and 6to4 / Teredo embeddings are all blocked.
- The sender **pins the undici connection to the pre-validated address**, so DNS
  cannot rebind to a private target between validation and connect.
- Regression tests cover the classifier and the pinning.

The residual risk this runbook addresses: a future code path that calls out to a
user-controlled URL **without** going through `sender.ts`, or a logic bug in the
guard. A network-layer egress policy contains that blast radius regardless of
app code.

## Goal

From the app's runtime network, outbound connections to the following must be
dropped at the platform/network layer, independent of application code:

- Loopback: `127.0.0.0/8`, `::1`
- Link-local / metadata: `169.254.0.0/16` (incl. `169.254.169.254`), `fe80::/10`
- Private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`
- CGNAT: `100.64.0.0/10`
- Other non-global: multicast, reserved, unspecified.

Only the two egress destinations the app legitimately needs stay open:
customer webhook endpoints (arbitrary public HTTPS) and GitHub
(`api.github.com`, `github.com`, `codeload.github.com`).

## Deployment context

Both environments run on Fly.io (`fly.toml` → app `specboard`, `fly.test.toml` →
app `specboard-test`, org `specboard`, region `sjc`). Fly Machines get
unrestricted public egress by default and Fly does not expose a per-app outbound
ACL in the standard product, so the egress policy has to be enforced by
something we run. Two viable approaches, cheapest first:

### Option A (recommended): forward-proxy sidecar with an IP deny ACL

Route all app-originated outbound HTTP(S) through a small proxy that refuses to
connect to non-global addresses, and give the app **no** other route out.

1. Add a proxy (e.g. `tinyproxy` or `squid`) as a second process/container in
   the Machine, listening on loopback only.
2. Configure it to deny CONNECT/GET to the CIDR list above (squid: `acl
   blocked_ranges dst <cidrs>` + `http_access deny blocked_ranges`; resolve DNS
   at the proxy so the ACL sees the resolved IP).
3. Point the app at it: set `HTTPS_PROXY` / `HTTP_PROXY` and thread the proxy
   agent into the webhook sender's undici dispatcher. Confirm `NO_PROXY` does
   **not** include anything that re-opens a private route.
4. The in-code pin still runs first; the proxy is the second gate.

Trade-off: the connection pin and the proxy both want to choose the target IP.
Keep the pin for direct correctness and let the proxy be the coarse network
backstop; do not drop the pin.

### Option B: egress via a WireGuard NAT gateway that drops private ranges

Send app egress through a Fly WireGuard peer / gateway Machine whose `iptables`
(or `nft`) OUTPUT/FORWARD chain drops the CIDR list. Heavier to operate; use
only if a proxy can't be introduced.

## Verification (run on test first, then prod)

From inside the running Machine (`fly ssh console -a specboard-test`):

1. A blocked target is refused at the network layer, not just by app code:
   ```sh
   # metadata IP — must fail to connect / time out, not return data
   curl -sv --max-time 5 http://169.254.169.254/ ; echo "exit=$?"
   # loopback and a private address — must be refused
   curl -sv --max-time 5 http://127.0.0.1:3000/ ; echo "exit=$?"
   curl -sv --max-time 5 http://10.0.0.1/ ; echo "exit=$?"
   ```
2. A legitimate public destination still works:
   ```sh
   curl -sS --max-time 5 https://api.github.com/zen ; echo
   ```
3. App-level: register a webhook endpoint pointing at `http://169.254.169.254/`
   and at `http://127.0.0.1/`, trigger a delivery, and confirm both are marked
   `failed` as blocked (the drainer records a terminal "Blocked URL"). This
   exercises the in-code guard; the network policy is what protects you if that
   guard regresses.

## Rollback

Remove the proxy env vars (`HTTPS_PROXY`/`HTTP_PROXY`) and redeploy, or tear
down the gateway Machine. The in-code SSRF guard remains in force, so removing
the platform layer degrades to "still protected by app code," not "open."

## Done when

- Test and prod egress drop the CIDR list above at the network layer, verified
  by steps 1-3.
- The webhook sender's outbound path is confirmed to traverse the policy (proxy
  env threaded into the undici dispatcher, or all egress routed via the
  gateway).
- The card is moved to done with a note recording which option was deployed.
