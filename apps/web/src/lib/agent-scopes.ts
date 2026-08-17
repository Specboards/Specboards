import { SCOPE_RESOURCES, type ScopeResource } from "@/lib/api-scopes";

/**
 * How the agent-creation UI presents API scopes.
 *
 * `SCOPE_RESOURCES` is a flat list of ~30 resources, which is the right shape
 * for validation and the wrong one for a person deciding what to trust an agent
 * with. These groups give that list an order and a label per resource, so the
 * question reads as "what jobs may this agent do" rather than "tick some route
 * prefixes".
 *
 * Every resource must appear in exactly one group. A resource missing here
 * would be silently ungrantable from the UI - the owner could never tick it,
 * and an agent could never be given it - so `agent-scopes.test.ts` fails the
 * build when a new resource lands without a home.
 */

export type ScopeLevel = "none" | "read" | "write";

export interface ScopeGroup {
  title: string;
  /** Why an owner would grant anything in this group. */
  hint: string;
  resources: { resource: ScopeResource; label: string }[];
}

export const SCOPE_GROUPS: ScopeGroup[] = [
  {
    title: "Work",
    hint: "The board itself: cards, specs, and the workflow they move through.",
    resources: [
      { resource: "features", label: "Work items" },
      { resource: "specs", label: "Specs" },
      { resource: "comments", label: "Comments" },
      // Named for what granting it costs, because it is the only scope on this
      // screen that spends money outside Specboards. Deliberately absent from
      // the "Author specs" preset below: an agent being granted these scopes is
      // already a model, and does not need a second one billed to the customer.
      { resource: "assistant", label: "Assistant (spends model credit)" },
      { resource: "statuses", label: "Stages" },
      { resource: "stage-gates", label: "Stage gates" },
      { resource: "properties", label: "Custom properties" },
      { resource: "detail-templates", label: "Detail templates" },
      { resource: "levels", label: "Hierarchy levels" },
    ],
  },
  {
    title: "Planning",
    hint: "What ships when, and what it is meant to achieve.",
    resources: [
      { resource: "releases", label: "Releases" },
      { resource: "cycles", label: "Cycles" },
      { resource: "goals", label: "Goals" },
      { resource: "key-results", label: "Key results" },
      { resource: "views", label: "Saved views" },
      { resource: "board-preferences", label: "Board preferences" },
    ],
  },
  {
    title: "Knowledge",
    hint: "The narrative plan: strategy, research, architecture, and intake.",
    resources: [
      { resource: "docs", label: "Doc pages" },
      { resource: "doc-spaces", label: "Doc areas" },
      { resource: "ideas", label: "Ideas" },
      { resource: "idea-statuses", label: "Idea statuses" },
      { resource: "idea-settings", label: "Idea settings" },
    ],
  },
  {
    title: "Workspace",
    hint: "Administration. Most agents need read here, if anything.",
    resources: [
      { resource: "products", label: "Products" },
      { resource: "product-groups", label: "Product groups" },
      { resource: "repositories", label: "Repositories" },
      { resource: "webhooks", label: "Webhooks" },
      { resource: "notifications", label: "Notifications" },
      { resource: "org", label: "Organization" },
      { resource: "workspace", label: "Workspace settings" },
      { resource: "me", label: "Own profile" },
    ],
  },
];

/** Every resource the groups cover, in display order. */
export const GROUPED_RESOURCES: ScopeResource[] = SCOPE_GROUPS.flatMap((g) =>
  g.resources.map((r) => r.resource),
);

/**
 * Turn a per-resource level map into the `<resource>:<action>` list the API
 * validates. `none` contributes nothing, so an agent with everything set to
 * `none` gets `[]` - which the key layer reads as UNRESTRICTED, not as "no
 * access". The UI must refuse to submit an empty selection for that reason;
 * see `AgentsCard`.
 */
export function scopesFromLevels(
  levels: Partial<Record<ScopeResource, ScopeLevel>>,
): string[] {
  const out: string[] = [];
  for (const resource of GROUPED_RESOURCES) {
    const level = levels[resource];
    if (level === "read") out.push(`${resource}:read`);
    if (level === "write") out.push(`${resource}:write`);
  }
  return out.sort();
}

/** The inverse, for rendering a stored key's scopes back into the grid. */
export function levelsFromScopes(
  scopes: readonly string[],
): Partial<Record<ScopeResource, ScopeLevel>> {
  const out: Partial<Record<ScopeResource, ScopeLevel>> = {};
  for (const scope of scopes) {
    const [resource, action] = scope.split(":");
    if (!resource || !SCOPE_RESOURCES.includes(resource as ScopeResource)) continue;
    if (action === "write") out[resource as ScopeResource] = "write";
    else if (action === "read") out[resource as ScopeResource] = "read";
  }
  return out;
}

/**
 * Starting points for the two things owners actually ask for, so the common
 * cases are one click rather than thirty. Both are explicit selections: they
 * fill the grid, which the owner can then adjust, rather than standing for a
 * hidden "and everything else" the way an empty scope list would.
 */
export const SCOPE_PRESETS: { id: string; label: string; describe: string; levels: () => Partial<Record<ScopeResource, ScopeLevel>> }[] = [
  {
    id: "read-only",
    label: "Read-only",
    describe: "Can see the whole workspace and change nothing.",
    levels: () =>
      Object.fromEntries(GROUPED_RESOURCES.map((r) => [r, "read" as ScopeLevel])),
  },
  {
    id: "author",
    label: "Author specs",
    describe:
      "Can define and break down work: cards, specs, docs and comments, plus the planning objects they hang off.",
    levels: () => {
      const levels = Object.fromEntries(
        GROUPED_RESOURCES.map((r) => [r, "read" as ScopeLevel]),
      ) as Partial<Record<ScopeResource, ScopeLevel>>;
      for (const r of [
        "features",
        "specs",
        "comments",
        "docs",
        "releases",
        "cycles",
        "goals",
        "key-results",
      ] as ScopeResource[]) {
        levels[r] = "write";
      }
      return levels;
    },
  },
];
