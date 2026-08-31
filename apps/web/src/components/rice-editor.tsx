"use client";

import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  computeRiceScore,
  formatRiceScore,
  RICE_IMPACT_OPTIONS,
} from "@/lib/feature-helpers";
import { cn } from "@/lib/utils";

/** The four RICE inputs as editable strings; "" means unset. */
export interface RiceStrings {
  reach: string;
  impact: string;
  confidence: string;
  effort: string;
}

const EMPTY_RICE: RiceStrings = {
  reach: "",
  impact: "",
  confidence: "",
  effort: "",
};

/** Reach is an open-ended count, so the scale is a ladder of round magnitudes
 * with a free number field beside it for anything in between. */
const REACH_STEPS = [10, 50, 100, 500, 1000, 5000];
/** Effort in person-months, on the near-Fibonacci ladder estimation usually
 * lands on. Also free-typeable. */
const EFFORT_STEPS = [0.5, 1, 2, 3, 5, 8];
/** The canonical RICE confidence anchors; the slider moves in 5% steps between
 * them for anything else. */
const CONFIDENCE_STEPS = [
  { value: 50, label: "Low" },
  { value: 80, label: "Medium" },
  { value: 100, label: "High" },
];

function num(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Compact number for the trigger summary: 5000 reads as 5k. */
function compact(v: string): string {
  const n = num(v);
  if (n === null) return "—";
  return n >= 1000 ? `${n / 1000}k` : String(n);
}

/**
 * The RICE score editor: a summary button that opens a flyout where each of the
 * four inputs is set on its own labelled scale, with the score recomputed live
 * underneath. It replaces four look-alike number boxes whose meaning and units
 * you had to already know (and whose values only made sense together).
 */
export function RiceEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: RiceStrings;
  /** `commit` is true for a discrete pick (a step, Clear) that should save at
   * once, and false while typing in a free field, which is debounced. */
  onChange: (next: RiceStrings, commit: boolean) => void;
  disabled?: boolean;
}) {
  const inputs = {
    riceReach: num(value.reach),
    riceImpact: num(value.impact),
    riceConfidence: num(value.confidence),
    riceEffort: num(value.effort),
  };
  const score = computeRiceScore(inputs);
  const scored = score !== null;
  const anySet = Object.values(inputs).some((v) => v !== null);

  const set = (patch: Partial<RiceStrings>, commit: boolean) =>
    onChange({ ...value, ...patch }, commit);

  const impactLabel = RICE_IMPACT_OPTIONS.find(
    (o) => String(o.value) === value.impact,
  )?.label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          className="h-7 w-full max-w-full justify-start gap-2 border border-transparent px-2 font-normal hover:bg-muted sm:max-w-[16rem]"
        >
          {scored ? (
            <>
              <span className="font-medium tabular-nums">
                {formatRiceScore(score)}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                R {compact(value.reach)} · I {value.impact}× · C{" "}
                {value.confidence}% · E {value.effort}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {anySet ? "Incomplete score" : "Set score"}
            </span>
          )}
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-3">
        <div className="space-y-3">
          <Scale
            label="Reach"
            hint="People affected per quarter"
            steps={REACH_STEPS}
            value={value.reach}
            onPick={(v) => set({ reach: v }, true)}
            onType={(v) => set({ reach: v }, false)}
            inputProps={{ min: 0, step: 1, "aria-label": "Reach" }}
          />

          <div className="space-y-1.5">
            <ScaleHeader
              label="Impact"
              hint={impactLabel ?? "How much per person"}
            />
            <div className="flex flex-wrap gap-1">
              {RICE_IMPACT_OPTIONS.map((o) => (
                <StepButton
                  key={o.value}
                  selected={value.impact === String(o.value)}
                  onClick={() =>
                    set(
                      {
                        impact:
                          value.impact === String(o.value)
                            ? ""
                            : String(o.value),
                      },
                      true,
                    )
                  }
                >
                  {/* The space is a real text node, not just the margin: it is
                      what a screen reader reads between the two parts. */}
                  {o.label.replace(/\s*\(.*\)$/, "")}{" "}
                  <span className="text-muted-foreground">{o.value}×</span>
                </StepButton>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <ScaleHeader
              label="Confidence"
              hint={value.confidence === "" ? "Unset" : `${value.confidence}%`}
            />
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              aria-label="Confidence (%)"
              value={value.confidence === "" ? 80 : value.confidence}
              onChange={(e) => set({ confidence: e.target.value }, true)}
              className="h-4 w-full cursor-pointer accent-primary"
            />
            <div className="flex gap-1">
              {CONFIDENCE_STEPS.map((c) => (
                <StepButton
                  key={c.value}
                  selected={value.confidence === String(c.value)}
                  onClick={() => set({ confidence: String(c.value) }, true)}
                >
                  {c.label}{" "}
                  <span className="text-muted-foreground">{c.value}%</span>
                </StepButton>
              ))}
            </div>
          </div>

          <Scale
            label="Effort"
            hint="Person-months"
            steps={EFFORT_STEPS}
            value={value.effort}
            onPick={(v) => set({ effort: v }, true)}
            onType={(v) => set({ effort: v }, false)}
            inputProps={{
              min: 0,
              step: 0.5,
              "aria-label": "Effort (person-months)",
            }}
          />

          {/* The running score, and what it is made of: the formula is the whole
              reason these four values are edited together. */}
          <div className="flex items-baseline justify-between gap-2 border-t pt-2.5">
            <div className="min-w-0">
              <span className="text-xs text-muted-foreground">Score </span>
              <span className="text-sm font-medium tabular-nums">
                {formatRiceScore(score)}
              </span>
              {scored ? (
                <p className="truncate text-2xs text-muted-foreground">
                  {value.reach} × {value.impact} × {value.confidence}% ÷{" "}
                  {value.effort}
                </p>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  Set all four to score
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!anySet}
              onClick={() => onChange(EMPTY_RICE, true)}
            >
              Clear
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScaleHeader({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium">{label}</span>
      <span className="truncate text-2xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/** A labelled ladder of preset values plus a free number field, for the two
 * inputs (reach, effort) whose range is open-ended. */
function Scale({
  label,
  hint,
  steps,
  value,
  onPick,
  onType,
  inputProps,
}: {
  label: string;
  hint: string;
  steps: number[];
  value: string;
  onPick: (v: string) => void;
  onType: (v: string) => void;
  inputProps: React.InputHTMLAttributes<HTMLInputElement>;
}) {
  return (
    <div className="space-y-1.5">
      <ScaleHeader label={label} hint={hint} />
      <div className="flex flex-wrap items-center gap-1">
        {steps.map((s) => (
          <StepButton
            key={s}
            selected={value === String(s)}
            onClick={() => onPick(value === String(s) ? "" : String(s))}
          >
            {s >= 1000 ? `${s / 1000}k` : s}
          </StepButton>
        ))}
        <Input
          type="number"
          value={value}
          placeholder="Custom"
          onChange={(e) => onType(e.target.value)}
          className="h-7 w-20 px-2 text-xs"
          {...inputProps}
        />
      </div>
    </div>
  );
}

/** One value on a scale: pressed when it is the current pick. */
function StepButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "h-7 rounded-md border px-2 text-xs transition-colors",
        selected
          ? "border-primary bg-primary/15 font-medium text-foreground"
          : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
