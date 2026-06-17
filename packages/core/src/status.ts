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
}

export const defaultWorkflow: StatusWorkflow = {
  statuses: DEFAULT_STATUSES,
  transitions: DEFAULT_TRANSITIONS,
};

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
