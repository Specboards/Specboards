import path from "node:path";

/**
 * Where local file mode keeps each thing.
 *
 * The store carried twenty-two getters for these, every one of them the same
 * `path.join(root, ".specboards", "local-<something>.json")`. That is
 * twenty-two chances to mistype a filename and no single place to see the shape
 * of the directory, so they are one table here instead. The literals are
 * unchanged: a file written by an earlier version is still read by this one.
 *
 * `specs/` is deliberately not in the table. It is the repository's own
 * directory, versioned in git and edited by people, not state this store owns.
 */

const FILES = {
  boardPrefs: "local-board-prefs.json",
  comments: "local-comments.json",
  cycles: "local-cycles.json",
  detailTemplates: "local-detail-templates.json",
  docPages: "local-doc-pages.json",
  docSpaces: "local-doc-spaces.json",
  gateCompletions: "local-gate-completions.json",
  goals: "local-goals.json",
  ideaSettings: "local-idea-settings.json",
  ideaStatuses: "local-idea-statuses.json",
  ideas: "local-ideas.json",
  items: "local-items.json",
  levels: "local-levels.json",
  metadata: "local-metadata.json",
  productGroups: "local-product-groups.json",
  products: "local-products.json",
  properties: "local-properties.json",
  releases: "local-releases.json",
  stageGates: "local-stage-gates.json",
  statuses: "local-statuses.json",
  views: "local-views.json",
} as const;

/** One of local mode's JSON files, by the thing it holds. */
type LocalFile = keyof typeof FILES;

/** The path of one of local mode's JSON files under `.specboards/`. */
export function localPath(root: string, file: LocalFile): string {
  return path.join(root, ".specboards", FILES[file]);
}

/**
 * The repository's `specs/` directory: the source of truth for spec-backed
 * items, read but never written here.
 */
export function specsDir(root: string): string {
  return path.join(root, "specs");
}
