/**
 * The default workflow a feature moves through. Teams can override the vocabulary
 * and transitions via `.specboards/config.yml` (see {@link ./config}), but this is
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

/**
 * How freely an item may move between stages.
 *
 * `strict` is a pipeline: one step forward, one step back, or archive. It suits
 * a team that wants the board to reflect a real process, and it pairs with
 * stage gates to hold work until its exit criteria are met.
 *
 * `flexible` lets any stage reach any other. It suits a team that treats the
 * board as a place to record where things are rather than a process to walk,
 * and it means one call (human or agent) can move an item from `backlog` to
 * `in_review` without stepping through everything between.
 *
 * Stage gates apply in both modes: a forward move still has to satisfy the
 * gates of every stage it passes over, so `flexible` loosens sequencing without
 * loosening governance.
 */
export type TransitionMode = "strict" | "flexible";

export const TRANSITION_MODES: readonly TransitionMode[] = ["strict", "flexible"];

/**
 * What a workspace does before anyone chooses. Named here rather than left as a
 * column default because the setting now lives in `product_settings`, where
 * every value is nullable to mean "inherit": the bottom of the inheritance
 * chain has to be a constant the code knows, not one the schema supplies.
 * Matches the `workspaces.transition_mode` default it replaces, so a workspace
 * that never configured this keeps behaving the same.
 */
export const DEFAULT_TRANSITION_MODE: TransitionMode = "flexible";

/** Whether `value` is a valid {@link TransitionMode}. */
export function isTransitionMode(value: unknown): value is TransitionMode {
  return typeof value === "string" && TRANSITION_MODES.includes(value as TransitionMode);
}

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

/** Every stage reaches every other. `archived` is included as a destination. */
export function flexibleTransitions(
  stagesWithArchived: readonly string[],
): Record<string, string[]> {
  return Object.fromEntries(
    stagesWithArchived.map((k) => [
      k,
      stagesWithArchived.filter((other) => other !== k),
    ]),
  );
}

/**
 * Pipeline transitions for an ordered stage list (excluding `archived`): one
 * step forward, one step back, or archive; `archived` returns to the first
 * stage.
 *
 * The built-in vocabulary keeps {@link DEFAULT_TRANSITIONS} verbatim rather
 * than being regenerated, because it has one deliberate edge this rule cannot
 * express: `done` reopens to `in_progress` (straight back to work) rather than
 * to `in_review`. Regenerating would silently drop that move, which the board
 * offers as a drag from Done to In Progress.
 */
export function strictTransitions(
  stages: readonly string[],
): Record<string, string[]> {
  if (isDefaultVocabulary(stages)) {
    return Object.fromEntries(
      Object.entries(DEFAULT_TRANSITIONS).map(([k, v]) => [k, [...v]]),
    );
  }
  const transitions: Record<string, string[]> = {};
  stages.forEach((key, i) => {
    const step: string[] = [];
    const next = stages[i + 1];
    const prev = stages[i - 1];
    if (next) step.push(next);
    if (prev) step.push(prev);
    step.push("archived");
    transitions[key] = step;
  });
  const first = stages[0];
  transitions.archived = first ? [first] : [];
  return transitions;
}

/** Whether `stages` is exactly the built-in vocabulary (archived aside). */
function isDefaultVocabulary(stages: readonly string[]): boolean {
  const builtin = DEFAULT_STATUSES.filter((s) => s !== "archived");
  return (
    stages.length === builtin.length &&
    stages.every((s, i) => s === builtin[i])
  );
}

/**
 * Build a {@link StatusWorkflow} from admin-defined stages (ordered). The
 * system `archived` status is appended so items can still be archived and
 * dropped from the board (which hides `archived`). Returns null when there are
 * fewer than two stages, so callers fall back to config/default.
 *
 * `mode` decides the transitions: see {@link TransitionMode}. It is required
 * rather than defaulted, because silently picking one is how a workspace ends
 * up in a mode nobody chose.
 */
export function workflowFromStages(
  stages: readonly { key: string; label: string }[],
  mode: TransitionMode,
): StatusWorkflow | null {
  if (stages.length < 2) return null;
  const keys = stages.map((s) => s.key);
  const withArchived = [...keys, "archived"];
  const transitions =
    mode === "flexible"
      ? flexibleTransitions(withArchived)
      : strictTransitions(keys);
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
  if (!workflow.statuses.includes(to)) {
    return (
      `Illegal transition: ${from} -> ${to}. ${hint} "${to}" is not a status ` +
      `in this workspace; valid statuses are: ${workflow.statuses.join(", ")}.`
    );
  }
  // `to` is a real status just not reachable in one step, which is the common
  // case on a strict workflow. Name both ways out so the caller doesn't have to
  // brute-force the chain one call at a time.
  const reachable = shortestTransitionPath(from, to, workflow);
  const route =
    reachable && reachable.length > 1
      ? ` Pass advance to walk it there via ${reachable.slice(0, -1).join(" -> ")}, ` +
        `or set this workspace's transitions to flexible in Settings > Cards > Workflow.`
      : "";
  return `Illegal transition: ${from} -> ${to}. ${hint}${route}`;
}

/**
 * Shortest legal path from `from` to `to` through the workflow's transitions,
 * as the ordered list of intermediate-and-final statuses to move through
 * (excluding `from`). Returns `[]` when already at the target, or `null` when
 * no legal path exists.
 *
 * `archived` is never used as an intermediate hop (it drops an item off the
 * board, not down the pipeline); it is only ever a destination when `to` is
 * itself `archived`. This is a plain breadth-first search, so the result is a
 * fewest-hops path; ties are broken by transition-declaration order.
 */
export function shortestTransitionPath(
  from: string,
  to: string,
  workflow: StatusWorkflow = defaultWorkflow,
): string[] | null {
  if (from === to) return [];
  if (!workflow.statuses.includes(to)) return null;

  const visited = new Set<string>([from]);
  // Queue of (node, path-taken-to-reach-node-excluding-`from`).
  const queue: Array<{ node: string; path: string[] }> = [
    { node: from, path: [] },
  ];

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    for (const next of workflow.transitions[node] ?? []) {
      if (visited.has(next)) continue;
      // Skip `archived` unless it is the requested destination.
      if (next === "archived" && to !== "archived") continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      visited.add(next);
      queue.push({ node: next, path: nextPath });
    }
  }
  return null;
}

/**
 * Resolve the active {@link StatusWorkflow} from a repo config. A team
 * customizes its statuses/transitions in `.specboards/config.yml`; when that's
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
  const transitions = config?.transitions ?? flexibleTransitions(statuses);
  return { statuses: [...statuses], transitions };
}

/** Whether a repo config pins the state machine itself (transitions given). */
export function configPinsTransitions(
  config?: {
    statuses?: readonly string[];
    transitions?: Record<string, string[]>;
  } | null,
): boolean {
  return (
    !!config?.statuses &&
    config.statuses.length >= 2 &&
    !!config.transitions &&
    Object.keys(config.transitions).length > 0
  );
}
