#!/usr/bin/env bash
# Dependency audit gate: fail on a production advisory, and fail just as loudly
# when we could not find out.
#
# ── Why this is a script and not a one-line pnpm invocation ─────────────────
# It used to be:
#
#   pnpm audit --prod --audit-level moderate --ignore-registry-errors
#
# `--ignore-registry-errors` exits zero when the advisory endpoint cannot be
# reached, which produces a green check indistinguishable from a clean tree.
# That check is load-bearing: the audit currently passes with no suppressions at
# all (the round-1 @hono/node-server exception was retired in #271), so a green
# tick is the whole of the claim. It must not be able to mean "we did not ask".
#
# Dropping the flag outright is the other obvious option, and it trades a lie
# for flakiness: npm's advisory endpoint has bad minutes, and a CI run that
# fails for that reason teaches people to re-run red builds without reading
# them, which is worse than either.
#
# So: ask properly, retry a transient failure, and if we still cannot get an
# answer, fail with a message that says which of the two things happened.
#
# The distinction is drawn on whether a well-formed report came back at all.
# `pnpm audit --json` emits a `metadata.vulnerabilities` object on any real
# answer, clean or not. No parseable report means we did not get one, whatever
# the exit code claims.
#
# ── Why the verdict does not come from those counts ─────────────────────────
# It used to, and that made the exception process this script advertises
# unusable. `pnpm.auditConfig.ignoreGhsas` filters the `advisories` map and
# leaves `metadata.vulnerabilities` untouched, so an accepted, documented
# exception still failed the gate, and the failure message helpfully suggested
# adding it to `ignoreGhsas` (where it already was). Verified against a real
# advisory: with the id ignored, `advisories` is `{}` while
# `metadata.vulnerabilities.moderate` still reads 2.
#
# A gate whose own documented escape hatch does nothing is not a strict gate,
# it is one somebody eventually reaches past: `--audit-level high`, or deleting
# the step. So the verdict is now the `advisories` entries at or above the
# level, which is what the report actually claims after suppressions.
#
# `metadata.vulnerabilities` keeps its original job, which is a different
# question: it is the probe for "did a real answer come back at all". An empty
# `advisories` map is a legitimate clean result, so it cannot distinguish a
# clean tree from a failed request, and the presence of the counts object still
# can.
set -uo pipefail

ATTEMPTS=3
LEVEL=moderate

for attempt in $(seq 1 "$ATTEMPTS"); do
  report="$(pnpm audit --prod --audit-level "$LEVEL" --json 2>/dev/null)"

  printf '%s' "$report" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          process.exit(1);
        }
        // Only ever the "did we get an answer" probe. See the header: these
        // counts ignore `ignoreGhsas`, so they cannot be the verdict.
        const counts = parsed?.metadata?.vulnerabilities;
        if (!counts || typeof counts !== "object") process.exit(1);

        // The verdict. `advisories` is what the report still asserts after
        // suppressions. `info` and `low` are reported by the scheduled full
        // audit (security-audit.yml) and do not fail a PR.
        const GATED = ["moderate", "high", "critical"];
        const reported = Object.values(parsed?.advisories ?? {}).filter((a) =>
          GATED.includes(String(a?.severity)),
        );
        if (reported.length === 0) {
          const muted = GATED.reduce((n, k) => n + Number(counts[k] ?? 0), 0);
          console.log(
            "[audit] clean: no production advisories at moderate or above." +
              // Say so when the tree is clean only because something is muted:
              // a green tick that depends on an exception should not read the
              // same as one that does not.
              (muted > 0
                ? ` (${muted} suppressed via pnpm.auditConfig.ignoreGhsas; see docs/security-audit-exceptions.md)`
                : ""),
          );
          process.exit(0);
        }
        const bySeverity = GATED.map((k) => [
          k,
          reported.filter((a) => a.severity === k).length,
        ]).filter(([, n]) => n > 0);
        console.error(
          "[audit] production advisories found: " +
            bySeverity.map(([k, n]) => `${n} ${k}`).join(", "),
        );
        for (const a of reported) {
          console.error(
            `[audit]   ${a.github_advisory_id ?? a.id} (${a.severity}) ${a.module_name ?? ""}: ${a.title ?? ""}`,
          );
        }
        // 2, not 1, so the caller can tell "found something" from "could not
        // ask". Both fail the build; only one of them is worth retrying.
        process.exit(2);
      });
    '
  # Captured immediately, and NOT via `if ... then`: a failed `if` condition
  # with no `else` leaves $? at 0, so reading it after the block reported every
  # real advisory as an unreachable registry and retried it twice. Found by
  # feeding the script a stub that returns advisories.
  status=$?

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if [ "$status" -eq 2 ]; then
    echo "[audit] Run 'pnpm audit --prod' for the detail." >&2
    echo "[audit] To accept one deliberately, add its GHSA id to" >&2
    echo "        pnpm.auditConfig.ignoreGhsas in package.json and record it," >&2
    echo "        with a review-by date, in docs/security-audit-exceptions.md." >&2
    exit 1
  fi

  echo "[audit] no usable report from the advisory endpoint (attempt ${attempt}/${ATTEMPTS})." >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * 5))
  fi
done

echo "[audit] Refusing to pass: the advisory endpoint could not be reached after ${ATTEMPTS} attempts," >&2
echo "        so the dependencies were never actually checked. This is not a clean tree." >&2
exit 1
