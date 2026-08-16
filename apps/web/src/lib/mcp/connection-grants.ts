import { SCOPE_RESOURCES } from "@/lib/api-scopes";

/**
 * What an OAuth-connected agent may do, as offered on the consent screen.
 *
 * Deliberately three choices rather than the ~30-row scope grid an owner gets
 * when creating an agent identity in Settings. This screen is shown mid-flow to
 * someone who just asked their coding agent to connect; a wall of resource
 * toggles there would be read by nobody and clicked through by everyone, which
 * is a worse outcome than three honest options.
 *
 * The default is `author`, not `full`. Before this existed every connection was
 * effectively `full` (`resolveMcpAuth` returned `scopes: []`, which
 * `keyScopesSatisfy` reads as unrestricted), so the default moving to `author`
 * is the actual security change here.
 */

export type ConnectionGrantId = "read" | "author" | "full";

export interface ConnectionGrant {
  id: ConnectionGrantId;
  label: string;
  describe: string;
  scopes: string[];
  /** Whether the connection may call tools flagged `destructive`. */
  allowDestructive: boolean;
}

/** Resources an authoring agent writes; everything else it only reads. */
const AUTHOR_WRITES = [
  "features",
  "specs",
  "comments",
  "docs",
  "releases",
  "cycles",
  "goals",
  "key-results",
] as const;

const readEverything = () => SCOPE_RESOURCES.map((r) => `${r}:read`);

export const CONNECTION_GRANTS: ConnectionGrant[] = [
  {
    id: "read",
    label: "Read only",
    describe: "See the board, specs and plans. Change nothing.",
    scopes: readEverything().sort(),
    allowDestructive: false,
  },
  {
    id: "author",
    label: "Read and author",
    describe:
      "Define and break down work: cards, specs, docs, comments and the plans they hang off. Cannot delete anything.",
    scopes: [
      ...readEverything().filter(
        (s) => !AUTHOR_WRITES.some((w) => s === `${w}:read`),
      ),
      ...AUTHOR_WRITES.map((w) => `${w}:write`),
    ].sort(),
    allowDestructive: false,
  },
  {
    id: "full",
    label: "Everything you can do",
    describe:
      "Your full access, including deleting items, goals and pages. Only for tools you control.",
    // The wildcard rather than an enumeration: this grant means "whatever the
    // user can do", which must keep tracking the user as roles change.
    scopes: ["*"],
    allowDestructive: true,
  },
];

export const DEFAULT_CONNECTION_GRANT: ConnectionGrantId = "author";

/** Resolve an untrusted grant id, falling back to the default. */
export function connectionGrantById(id: unknown): ConnectionGrant {
  const found = CONNECTION_GRANTS.find((g) => g.id === id);
  return found ?? CONNECTION_GRANTS.find((g) => g.id === DEFAULT_CONNECTION_GRANT)!;
}

/**
 * Name a stored grant for display, matching it back to the choice that produced
 * it. A connection made before consent asked the question has `null` scopes and
 * is reported as such rather than guessed at.
 */
export function describeStoredGrant(
  scopes: string[] | null,
  allowDestructive: boolean,
): string {
  if (scopes === null) {
    return "Full access (granted before connections could be scoped)";
  }
  const match = CONNECTION_GRANTS.find(
    (g) =>
      g.allowDestructive === allowDestructive &&
      g.scopes.length === scopes.length &&
      g.scopes.every((s) => scopes.includes(s)),
  );
  if (match) return match.label;
  const writes = scopes.filter((s) => s.endsWith(":write")).length;
  return `${scopes.length - writes} read, ${writes} write${
    allowDestructive ? ", may delete" : ""
  }`;
}
