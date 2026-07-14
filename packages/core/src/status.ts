/**
 * The default workflow a feature moves through. Teams can override the vocabulary
 * and transitions via `.specboard/config.yml` (see {@link ./config}), but this is
 * the out-of-the-box state machine.
 */
export const DEFAULT_STATUSES = [
  "backlog",
  "defining",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "archived",
] as const;

export type Status = (typeof DEFAULT_STATUSES)[number];

/** Allowed forward/backward transitions for the default workflow. */
const DEFAULT_TRANSITIONS: Record<Status, Status[]> = {
  backlog: ["defining", "archived"],
  defining: ["ready", "backlog", "archived"],
  ready: ["in_progress", "defining", "archived"],
  in_progress: ["in_review", "ready", "archived"],
  in_review: ["done", "in_progress", "archived"],
  done: ["archived", "in_progress"],
  archived: ["backlog"],
};

/** A status workflow: the ordered vocabulary plus its legal transitions. */
export interface StatusWorkflow {
  statuses: readonly string[];
  transitions: Record<string, string[]>;
  /**
   * Display label per status key. Optional: when a key is absent (or `labels`
   * is omitted entirely) callers title-case the key. Admin-defined workflows
   * carry explicit labels so a stage can be renamed without changing its key.
   */
  labels?: Record<string, string>;
}

export const defaultWorkflow: StatusWorkflow = {
  statuses: DEFAULT_STATUSES,
  transitions: DEFAULT_TRANSITIONS,
};

/**
 * Build a {@link StatusWorkflow} from admin-defined stages (ordered). Transitions
 * are open (any stage to any other), matching the config's "omit transitions"
 * rule, and the system `archived` status is appended so items can still be
 * archived and dropped from the board (which hides `archived`). Returns null when
 * there are fewer than two stages, so callers fall back to config/default.
 */
export function workflowFromStages(
  stages: readonly { key: string; label: string }[],
): StatusWorkflow | null {
  if (stages.length < 2) return null;
  const keys = stages.map((s) => s.key);
  const withArchived = [...keys, "archived"];
  const transitions = Object.fromEntries(
    withArchived.map((k) => [k, withArchived.filter((other) => other !== k)]),
  );
  const labels: Record<string, string> = { archived: "Archived" };
  for (const s of stages) labels[s.key] = s.label;
  return { statuses: withArchived, transitions, labels };
}

/**
 * Whether `from -> to` advances the item *forward* through the workflow: `to`
 * sits at a later position than `from` in the stage order. Moving to `archived`
 * is never "forward" (it drops the item off the board, not down the pipeline),
 * so it's excluded. Stage gates guard only forward moves; pulling an item back
 * to an earlier stage or archiving it is always allowed. Returns false when
 * either status is unknown to the workflow.
 */
export function isForwardTransition(
  from: string,
  to: string,
  workflow: StatusWorkflow = defaultWorkflow,
): boolean {
  if (from === to || to === "archived") return false;
  const fromIndex = workflow.statuses.indexOf(from);
  const toIndex = workflow.statuses.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return false;
  return toIndex > fromIndex;
}

/** Whether `from -> to` is a legal move in the given workflow. */
export function canTransition(
  from: string,
  to: string,
  workflow: StatusWorkflow = defaultWorkflow,
): boolean {
  if (from === to) return true;
  return workflow.transitions[from]?.includes(to) ?? false;
}

/**
 * A rejection message for an illegal `from -> to` move that tells the caller
 * (usually a coding agent) exactly how to recover: the statuses reachable from
 * `from`, and - when `to` isn't a status at all - the full vocabulary. Agents
 * otherwise brute-force stage keys blindly, since the default workflow allows
 * only single-step moves (e.g. `backlog` reaches only `defining`/`archived`).
 */
export function transitionErrorMessage(
  from: string,
  to: string,
  workflow: StatusWorkflow = defaultWorkflow,
): string {
  const allowed = workflow.transitions[from] ?? [];
  const hint = allowed.length
    ? `Allowed from "${from}": ${allowed.join(", ")}.`
    : `"${from}" has no outgoing transitions in this workflow.`;
  const vocab = workflow.statuses.includes(to)
    ? ""
    : ` "${to}" is not a status in this workspace; valid statuses are: ${workflow.statuses.join(", ")}.`;
  return `Illegal transition: ${from} -> ${to}. ${hint}${vocab}`;
}

/**
 * Resolve the active {@link StatusWorkflow} from a repo config. A team
 * customizes its statuses/transitions in `.specboard/config.yml`; when that's
 * absent (or under-specified) the {@link defaultWorkflow} applies, so existing
 * data keeps working unchanged. When `statuses` are given but `transitions`
 * are omitted, any status may move to any other (the config's documented
 * "omit to allow any transition" rule).
 */
export function resolveWorkflow(
  config?: {
    statuses?: readonly string[];
    transitions?: Record<string, string[]>;
  } | null,
): StatusWorkflow {
  const statuses = config?.statuses;
  if (!statuses || statuses.length < 2) return defaultWorkflow;
  const transitions =
    config?.transitions ??
    Object.fromEntries(
      statuses.map((s) => [s, statuses.filter((other) => other !== s)]),
    );
  return { statuses: [...statuses], transitions };
}
