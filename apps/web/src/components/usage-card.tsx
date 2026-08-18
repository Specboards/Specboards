"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { UsageLimits, UsageSummary } from "@/lib/usage-service";

/** Something to tell the user, and how loudly. */
type Notice = { kind: "ok" | "error"; message: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  if (notice.kind === "ok") {
    return <p className="text-sm text-muted-foreground">{notice.message}</p>;
  }
  return (
    <p
      role="alert"
      className="rounded border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {notice.message}
    </p>
  );
}

/** "August 2026", from the ISO instant the period started. */
export function periodLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What share of the month's budget is gone, as a percentage, or null when there
 * is no cap to be a share of. Clamped at 100: a cap can be overshot (the check
 * is a guardrail, not a payment authorization) and a bar past its own end reads
 * as a rendering fault rather than as the overshoot it is, which the number
 * beside it already states plainly.
 */
export function capUsedPercent(tokens: number, cap: number | null): number | null {
  if (cap === null || cap <= 0) return null;
  return Math.min(100, Math.round((tokens / cap) * 100));
}

/** A blank field means no cap, which is what the API expects as null. */
function capValue(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : Number(trimmed.replace(/[,\s]/g, ""));
}

function Rows({
  rows,
  empty,
}: {
  rows: { key: string; label: string; tokens: number; calls: number }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="flex justify-between gap-4">
          <span className="truncate">{r.label}</span>
          <span className="shrink-0 text-muted-foreground">
            {r.tokens.toLocaleString()} tokens
            <span className="ml-2 text-xs">
              ({r.calls.toLocaleString()} {r.calls === 1 ? "call" : "calls"})
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What this workspace has spent at its own model provider, and the caps on it.
 *
 * ── Why this is a page in the product and not a link to the provider ────────
 * The provider's own dashboard knows the total and nothing else. It cannot say
 * which part of Specboards caused a charge or who asked for it, which is the
 * only form of the question anybody actually has. It is also the customer's
 * account rather than ours, so "go and look" is us declining to answer for what
 * we spent on their behalf.
 *
 * ── Why tokens and not money ────────────────────────────────────────────────
 * We do not know the price. The endpoint may be a hosted vendor on a
 * negotiated rate, a gateway in front of several, or a machine in the
 * customer's own rack where the marginal cost of a token is electricity.
 * Maintaining a price table for all of that would produce a currency figure
 * that looks authoritative and is wrong, and a wrong number in a billing
 * dispute is worse than no number. Tokens are what we can count honestly, and
 * they are what every provider's own bill is denominated in.
 *
 * Caps follow the project's "add starts as an affordance" convention: with none
 * set this is one button, and the fields appear only when somebody asks for
 * them.
 */
export function UsageCard({
  initialSummary,
  canManage,
}: {
  initialSummary: UsageSummary | null;
  canManage: boolean;
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [limits, setLimits] = useState<UsageLimits>(
    initialSummary?.limits ?? {
      monthlyTokenCap: null,
      dailyUserTokenCap: null,
      updatedAt: null,
    },
  );
  const [open, setOpen] = useState(false);
  const [monthly, setMonthly] = useState("");
  const [daily, setDaily] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();

  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage and spend caps</CardTitle>
          <CardDescription>
            Only the workspace owner can see what the workspace has spent at its
            model provider.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function openForm() {
    setNotice(null);
    setMonthly(limits.monthlyTokenCap === null ? "" : String(limits.monthlyTokenCap));
    setDaily(limits.dailyUserTokenCap === null ? "" : String(limits.dailyUserTokenCap));
    setOpen(true);
  }

  function save() {
    setNotice(null);
    startTransition(async () => {
      const res = await fetch("/api/v1/model-provider/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyTokenCap: capValue(monthly),
          dailyUserTokenCap: capValue(daily),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as UsageLimits & {
        error?: string;
      };
      if (!res.ok) {
        setNotice({ kind: "error", message: data.error ?? "Could not save the caps." });
        return;
      }
      setLimits(data);
      setSummary((s) => (s ? { ...s, limits: data } : s));
      setOpen(false);
      setNotice({
        kind: "ok",
        message:
          data.monthlyTokenCap === null && data.dailyUserTokenCap === null
            ? "Caps removed. Specboards will not limit what it spends at your provider."
            : "Spend caps saved.",
      });
    });
  }

  const percent = capUsedPercent(summary.tokens, limits.monthlyTokenCap);
  const hasCaps =
    limits.monthlyTokenCap !== null || limits.dailyUserTokenCap !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage and spend caps</CardTitle>
        <CardDescription>
          Every token Specboards produces is billed to you by the provider you
          connected. This is what we sent, on whose behalf, and what it cost, so
          a line on that invoice is something you can trace rather than
          something you have to accept. Counted in tokens, not money: the price
          of a token is between you and your provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <NoticeLine notice={notice} />

        <div className="rounded border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {periodLabel(summary.periodStart)} (UTC)
            </span>
            <span className="text-lg font-semibold">
              {summary.tokens.toLocaleString()} tokens
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {summary.promptTokens.toLocaleString()} sent,{" "}
            {summary.completionTokens.toLocaleString()} generated, across{" "}
            {summary.calls.toLocaleString()}{" "}
            {summary.calls === 1 ? "call" : "calls"}.
          </p>

          {percent !== null ? (
            <div className="mt-3 space-y-1">
              {/* Not a progress element: this is a proportion of a budget, and
                  a screen reader announcing "loading" would be wrong. */}
              <div
                className="h-2 w-full overflow-hidden rounded bg-muted"
                role="img"
                aria-label={`${percent}% of the monthly cap used`}
              >
                <div
                  className={
                    percent >= 90 ? "h-full bg-destructive" : "h-full bg-primary"
                  }
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {percent}% of the {limits.monthlyTokenCap!.toLocaleString()}-token
                monthly cap.
              </p>
            </div>
          ) : null}

          {/* Stated rather than absorbed. A workspace whose runtime omits usage
              would otherwise read a total of zero as the accounting being
              broken, which is nearly right and exactly the wrong action. */}
          {summary.unmeasuredCalls > 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {summary.unmeasuredCalls.toLocaleString()} of these calls returned
              no token count, so the total above is a floor rather than a
              complete figure. Some self-hosted runtimes do not report usage.
            </p>
          ) : null}
          {summary.failedCalls > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {summary.failedCalls.toLocaleString()} failed. A call that failed
              before the model answered normally costs nothing, but it is
              recorded either way.
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">By feature</h3>
            <Rows
              rows={summary.byFeature}
              empty="Nothing spent this month."
            />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">By person</h3>
            <Rows rows={summary.byUser} empty="Nothing spent this month." />
          </div>
        </div>

        {canManage ? (
          <div className="space-y-3 border-t pt-4">
            {hasCaps && !open ? (
              <div className="space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Monthly cap</span>
                  <span>
                    {limits.monthlyTokenCap === null
                      ? "None"
                      : `${limits.monthlyTokenCap.toLocaleString()} tokens`}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    Per person, per day
                  </span>
                  <span>
                    {limits.dailyUserTokenCap === null
                      ? "None"
                      : `${limits.dailyUserTokenCap.toLocaleString()} tokens`}
                  </span>
                </div>
              </div>
            ) : null}

            {open ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="monthly-cap" className="text-sm font-medium">
                    Monthly cap, in tokens
                  </label>
                  <Input
                    id="monthly-cap"
                    inputMode="numeric"
                    value={monthly}
                    onChange={(e) => setMonthly(e.target.value)}
                    placeholder="Leave blank for no cap"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="daily-cap" className="text-sm font-medium">
                    Per person, per day, in tokens
                  </label>
                  <Input
                    id="daily-cap"
                    inputMode="numeric"
                    value={daily}
                    onChange={(e) => setDaily(e.target.value)}
                    placeholder="Leave blank for no cap"
                  />
                  <p className="text-xs text-muted-foreground">
                    Catches the failure a monthly cap does not: one person&apos;s
                    runaway afternoon spending the whole team&apos;s month. Resets
                    at midnight UTC.
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  A request that would take the workspace past a cap is refused
                  before it is sent, and the person is told which cap and who can
                  raise it. Caps are a guardrail rather than a hard billing
                  limit: two requests in flight at once can overshoot it by
                  roughly one call.
                </p>
                <div className="flex gap-2">
                  <Button type="button" onClick={save} disabled={pending}>
                    {pending ? "Saving…" : "Save caps"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setOpen(false)}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="outline" onClick={openForm}>
                {hasCaps ? "Change spend caps" : "Set spend caps"}
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
