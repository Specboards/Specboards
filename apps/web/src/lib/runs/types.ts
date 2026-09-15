/**
 * What a run is, and how an agent's report of one is read.
 *
 * Everything an external agent says about its own run arrives here as
 * untrusted input: a status it may have invented, a summary of any length, a
 * trace step it may be emitting in a loop. So the shapes below are parsed and
 * bounded rather than stored as given.
 *
 * Pure: no database, no network, no environment. Same rule as
 * `lib/proposals/types.ts`, and for the same reason.
 */

/**
 * Where a run is.
 *
 * About the run itself, not about what it produced. A run that drafted a
 * proposal is `succeeded`; whether that proposal was applied is the
 * proposal's business, and asking the run would mean keeping two rows in step.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Why a run started: the four trigger primitives, plus a person pressing go. */
export type RunTrigger =
  | "assignment"
  | "mention"
  | "schedule"
  | "event"
  | "manual";

export const RUN_TRIGGERS: readonly RunTrigger[] = [
  "assignment",
  "mention",
  "schedule",
  "event",
  "manual",
];

/** A run nobody can change any more. */
const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * The statuses an agent may report for its own run.
 *
 * `queued` is absent because only we can queue something, and `cancelled` is
 * absent because only a person can stop a run. An agent that could report
 * itself cancelled would be able to hide a failure as though somebody had
 * asked it to stop.
 */
const REPORTABLE: readonly RunStatus[] = [
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
];

/** A status an agent handed us that we do not accept. */
export class RunInputError extends Error {}

export function parseReportedStatus(raw: unknown): RunStatus {
  if (typeof raw !== "string" || !REPORTABLE.includes(raw as RunStatus)) {
    throw new RunInputError(
      `"status" must be one of: ${REPORTABLE.join(", ")}.`,
    );
  }
  return raw as RunStatus;
}

export function parseTrigger(raw: unknown): RunTrigger {
  if (raw === undefined || raw === null) return "manual";
  if (typeof raw !== "string" || !RUN_TRIGGERS.includes(raw as RunTrigger)) {
    throw new RunInputError(
      `"trigger" must be one of: ${RUN_TRIGGERS.join(", ")}.`,
    );
  }
  return raw as RunTrigger;
}

/**
 * Most steps one run's trace will keep.
 *
 * A backstop, not a view about how much work a run should do. An agent that
 * misreads its instructions and loops writes a step per iteration, and the
 * row has to stop growing somewhere well before it stops fitting. When the
 * cap is reached the OLDEST steps go: the end of a trace is what explains how
 * a run finished, and that is the question somebody reading it has.
 */
export const MAX_TRACE_STEPS = 100;

/** Longest a step's label may be. A label is a line, not a paragraph. */
const MAX_LABEL_CHARS = 200;
/** Longest a step's detail may be. */
const MAX_DETAIL_CHARS = 2_000;
/** Longest the one-line summary shown on the item card may be. */
const MAX_SUMMARY_CHARS = 300;
/** Longest an error message may be. */
const MAX_ERROR_CHARS = 2_000;
/** Longest a steering note may be. */
const MAX_STEER_CHARS = 2_000;

/** One thing a run did. */
export interface TraceStep {
  /** When, as the server saw it. Not the agent's clock. */
  at: string;
  label: string;
  detail?: string;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** A one-line summary, or null when the agent gave nothing usable. */
export function parseSummary(raw: unknown): string | null {
  // Newlines collapsed rather than rejected: an agent that writes two lines
  // meant to be helpful should not have its whole report refused, and the
  // card renders this on one line whatever it contains.
  const s = text(raw, MAX_SUMMARY_CHARS);
  return s === null ? null : s.replace(/\s+/g, " ");
}

export function parseError(raw: unknown): string | null {
  return text(raw, MAX_ERROR_CHARS);
}

export function parseSteer(raw: unknown): string | null {
  return text(raw, MAX_STEER_CHARS);
}

/**
 * Read a step an agent wants appended, or null when there is nothing to add.
 *
 * `at` is set here, from our clock. An agent's own timestamp would be the
 * only field on the row it could use to lie about ordering, and the trace is
 * read as a sequence.
 */
export function parseStep(raw: unknown, now: Date): TraceStep | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const label = text(raw, MAX_LABEL_CHARS);
    return label === null ? null : { at: now.toISOString(), label };
  }
  if (typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const label = text(src.label, MAX_LABEL_CHARS);
  if (label === null) return null;
  const detail = text(src.detail, MAX_DETAIL_CHARS);
  return {
    at: now.toISOString(),
    label,
    ...(detail === null ? {} : { detail }),
  };
}

/**
 * Read a trace back out of the database, dropping anything unreadable.
 *
 * Lenient, unlike the parsers above, and for the reason `parseEvidence` is:
 * these rows are already stored, and a trace with one bad step is still a
 * useful trace. Refusing to render it would lose the ninety-nine good ones.
 */
export function parseTrace(raw: unknown): TraceStep[] {
  if (!Array.isArray(raw)) return [];
  const out: TraceStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const src = entry as Record<string, unknown>;
    const label = text(src.label, MAX_LABEL_CHARS);
    const at = typeof src.at === "string" ? src.at : null;
    if (label === null || at === null) continue;
    const detail = text(src.detail, MAX_DETAIL_CHARS);
    out.push({ at, label, ...(detail === null ? {} : { detail }) });
  }
  return out;
}

/** Append a step, keeping the trace within {@link MAX_TRACE_STEPS}. */
export function appendStep(
  trace: TraceStep[],
  step: TraceStep,
): TraceStep[] {
  const next = [...trace, step];
  return next.length <= MAX_TRACE_STEPS
    ? next
    : next.slice(next.length - MAX_TRACE_STEPS);
}
