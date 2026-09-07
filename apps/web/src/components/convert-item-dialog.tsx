"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  convertItem,
  previewItemConversion,
} from "@/lib/api-client/work-items";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import type { ConversionPlan } from "@/lib/convert-item";
import { useOrgProductPath } from "@/lib/use-org";
import { useResetOnChange } from "@/lib/use-reset-on-change";
import { cn } from "@/lib/utils";

/**
 * Changing an item's type, with the consequences stated first.
 *
 * Working out that a Feature is really an Epic is the normal outcome of
 * breaking work down. Before this the only way through was to recreate the
 * card: copy the body across, re-point the children, re-schedule it, and lose
 * the original's id, comments and history.
 *
 * The preview is the feature and the write is the easy part, which is why this
 * asks the server what would happen every time the target changes rather than
 * describing it from what the client happens to know. A level decides which
 * parent is legal, which children are legal, whether a spec may be attached and
 * which fields exist; a client-side guess would be a preview the write does not
 * honour.
 *
 * Blockers name the items in the way and link to them, so the fix is one click
 * away and the second attempt succeeds. That is the whole bargain of refusing
 * rather than repairing: the refusal has to be actionable, or it is a dead end
 * with a polite tone.
 */
export function ConvertItemDialog({
  specId,
  currentLevel,
  levels,
  open,
  onOpenChange,
}: {
  specId: string;
  currentLevel: string;
  levels: { key: string; label: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border bg-background p-5 shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          {/* One level down so the chosen target and its plan are unmounted
              with the portal. Reopening starts from the current type again
              rather than from whatever was half-considered last time. */}
          <ConvertForm
            specId={specId}
            currentLevel={currentLevel}
            levels={levels}
            onDone={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ConvertForm({
  specId,
  currentLevel,
  levels,
  onDone,
}: {
  specId: string;
  currentLevel: string;
  levels: { key: string; label: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const options = levels.filter((l) => l.key !== currentLevel);
  // Start one level up rather than at the top of the list. The conversion
  // people actually reach for is "this is bigger than I thought", and offering
  // a two-level jump first invites confirming a change nobody meant. Falls back
  // to one level down for an item that is already at the top.
  const [target, setTarget] = useState(() => {
    const here = levels.findIndex((l) => l.key === currentLevel);
    return (levels[here - 1] ?? levels[here + 1] ?? options[0])?.key ?? "";
  });
  const [plan, setPlan] = useState<ConversionPlan | null>(null);
  const [loading, setLoading] = useState(Boolean(options[0]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleared during render rather than in the effect below, so there is never a
  // frame showing the previous target's plan under the new target's name. That
  // frame is the whole risk here: the plan is what somebody is about to
  // approve, and one that belongs to a different conversion is worse than none.
  useResetOnChange(target, () => {
    setPlan(null);
    setError(null);
    setLoading(true);
  });

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    previewItemConversion(specId, target)
      .then((next) => {
        if (!cancelled) setPlan(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A plan we could not fetch is not a plan with no blockers. Clearing it
        // is what keeps the Convert button disabled instead of enabling it on
        // an empty object.
        setPlan(null);
        setError(
          err instanceof Error ? err.message : "Could not plan this change.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [specId, target]);

  const blocked = !plan || plan.blockers.length > 0;

  async function onConvert() {
    setSaving(true);
    setError(null);
    try {
      await convertItem(specId, target);
      onDone();
      // The level is in the URL, so the page has to be re-resolved rather than
      // patched in place; the route canonicalizes the stale segment.
      router.refresh();
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      setError(err instanceof Error ? err.message : "Convert failed.");
      setSaving(false);
    }
  }

  const currentLabel =
    levels.find((l) => l.key === currentLevel)?.label ?? currentLevel;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DialogPrimitive.Title className="text-base font-medium">
          Change type
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-sm text-muted-foreground">
          The item keeps its id, body, status, schedule, comments and history.
        </DialogPrimitive.Description>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="rounded-md border px-2 py-1 text-muted-foreground">
          {currentLabel}
        </span>
        <ArrowRight aria-hidden className="h-4 w-4 text-muted-foreground" />
        <Select
          aria-label="New type"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-48"
        >
          {options.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </Select>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">
          Working out what changes…
        </p>
      ) : null}

      {plan && plan.blockers.length > 0 ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <AlertTriangle aria-hidden className="h-4 w-4" />
            This is not possible yet
          </p>
          {plan.blockers.map((b, i) => (
            <div key={i} className="space-y-1.5 text-sm">
              <p>{b.message}</p>
              {b.kind === "children-stranded" ? (
                <ul className="space-y-1">
                  {b.items.map((item) => (
                    <li key={item.specId}>
                      <Link
                        href={orgHref(`/backlog/${item.level}/${item.specId}`)}
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
              {b.kind === "gates-unsatisfiable" ? (
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {b.gates.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {plan && plan.blockers.length === 0 ? (
        plan.effects.length > 0 ? (
          <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">What this changes</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {plan.effects.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing else about the item changes.
          </p>
        )
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <DialogPrimitive.Close asChild>
          <Button variant="outline" size="sm" type="button">
            Cancel
          </Button>
        </DialogPrimitive.Close>
        <Button
          size="sm"
          type="button"
          onClick={() => void onConvert()}
          disabled={blocked || loading || saving || !target}
        >
          {saving ? "Converting…" : `Convert to ${labelOf(levels, target)}`}
        </Button>
      </div>
    </div>
  );
}

function labelOf(
  levels: { key: string; label: string }[],
  key: string,
): string {
  return levels.find((l) => l.key === key)?.label ?? key;
}
