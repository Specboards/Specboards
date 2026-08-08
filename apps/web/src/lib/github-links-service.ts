import {
  and,
  desc,
  eq,
  features,
  productRepositories,
  repositories,
} from "@specboards/db";
import {
  createGitHubRepoClient,
  type GithubArtifactMeta,
} from "@specboards/git";

import { getDb } from "@/lib/db";
import { getGithubApp } from "@/lib/github-app";
import { FeatureNotFoundError } from "@/lib/features-service";
import {
  getStore,
  type GithubLink,
  type GithubLinkInput,
  type GithubLinkKind,
  type ResolvedGithubLink,
  type WorkspaceScope,
} from "@/lib/store";

/**
 * Domain operations for GitHub links behind
 * /api/v1/features/:specId/github-links. Resolves the artifact's metadata from
 * GitHub (owner-side, like the sync engine) then persists through the store.
 */

export class InvalidGithubLinkError extends Error {}
export class GithubNotConfiguredError extends Error {}

const KINDS = new Set<GithubLinkKind>(["pull_request", "issue", "branch"]);

/** Parse and validate an untrusted github-link create body. */
export function parseGithubLinkInput(body: unknown): GithubLinkInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidGithubLinkError("Request body must be a JSON object.");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind as GithubLinkKind)) {
    throw new InvalidGithubLinkError(
      `kind must be one of: ${[...KINDS].join(", ")}.`,
    );
  }
  const kind = raw.kind as GithubLinkKind;

  // Optional: which connected repo the artifact lives in. Only needed when the
  // item's own repo can't be inferred and more than one candidate exists.
  let repo: string | undefined;
  if (raw.repo !== undefined && raw.repo !== null) {
    if (typeof raw.repo !== "string" || raw.repo.trim() === "") {
      throw new InvalidGithubLinkError(
        'repo must be a non-empty "owner/name" string.',
      );
    }
    repo = raw.repo.trim();
  }

  if (kind === "branch") {
    if (typeof raw.branch !== "string" || raw.branch.trim() === "") {
      throw new InvalidGithubLinkError("branch must be a non-empty string.");
    }
    return { kind, branch: raw.branch.trim(), repo };
  }

  if (
    typeof raw.number !== "number" ||
    !Number.isInteger(raw.number) ||
    raw.number <= 0
  ) {
    throw new InvalidGithubLinkError(
      `${kind} requires a positive integer number.`,
    );
  }
  return { kind, number: raw.number, repo };
}

/** A connected repo as the item detail's forms need to see it. */
export interface LinkableRepo {
  id: string;
  owner: string;
  name: string;
  /** The designated home for specs, which spec creation defaults to. */
  isSpecRepo: boolean;
}

/**
 * The workspace's connected repos, for the link form's repo picker and the
 * spec-create form's target. Returned ordered so the spec repo (the usual home
 * of specs) comes first, which makes `repos[0]` the sensible default target.
 * Empty in local file mode or when nothing is connected.
 */
export async function listLinkableRepos(
  workspaceId: string,
): Promise<LinkableRepo[]> {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      isSpecRepo: repositories.isSpecRepo,
    })
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId))
    .orderBy(desc(repositories.isSpecRepo), repositories.owner, repositories.name);
}

/** The repo coordinates a link resolves against. */
type RepoCoords = {
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: string;
  isSpecRepo: boolean;
};

const REPO_COLUMNS = {
  repoId: repositories.id,
  owner: repositories.owner,
  name: repositories.name,
  defaultBranch: repositories.defaultBranch,
  installationId: repositories.githubInstallationId,
  isSpecRepo: repositories.isSpecRepo,
} as const;

/** `owner/name` for messages that have to name a repo. */
function repoSlug(r: RepoCoords): string {
  return `${r.owner}/${r.name}`;
}

/**
 * Resolve which repository a link on `specId` should point at.
 *
 * A spec-backed item carries its own `repoId` (the repo the spec lives in), so
 * that always wins. A DB-native card (initiative/epic/feature) has no repo of
 * its own, and those are exactly the cards a team wants to attach a PR to, so
 * fall back outward: the repos mapped to the card's product, then the
 * workspace's repos. Within a tier a single candidate is used directly and the
 * workspace spec repo breaks a tie; anything still ambiguous asks the caller to
 * name a repo rather than guessing, since linking to the wrong repo would
 * resolve a PR number against the wrong project.
 *
 * `requested` is an explicit `owner/name` from the caller and short-circuits
 * the whole ladder (still checked against the workspace, so it can't reach
 * another tenant's repo).
 */
async function resolveFeatureRepo(
  specId: string,
  workspaceId: string,
  productId: string | null,
  requested?: string | null,
): Promise<RepoCoords> {
  const db = getDb();
  if (!db) {
    throw new GithubNotConfiguredError(
      "GitHub linking requires a connected repository.",
    );
  }

  if (requested) {
    const [owner, name] = splitRepoSlug(requested);
    const rows = await db
      .select(REPO_COLUMNS)
      .from(repositories)
      .where(
        and(
          eq(repositories.workspaceId, workspaceId),
          eq(repositories.owner, owner),
          eq(repositories.name, name),
        ),
      )
      .limit(1);
    if (!rows[0]) {
      throw new InvalidGithubLinkError(
        `No connected repository named ${requested} in this workspace.`,
      );
    }
    return rows[0];
  }

  // 1. The spec's own repo, for a spec-backed item.
  const own = await db
    .select(REPO_COLUMNS)
    .from(features)
    .innerJoin(repositories, eq(features.repoId, repositories.id))
    .where(
      and(eq(features.specId, specId), eq(features.workspaceId, workspaceId)),
    )
    .limit(1);
  if (own[0]) return own[0];

  // 2. Repos mapped to the card's product (the sync default first).
  if (productId) {
    const mapped = await db
      .select(REPO_COLUMNS)
      .from(productRepositories)
      .innerJoin(
        repositories,
        eq(productRepositories.repoId, repositories.id),
      )
      .where(
        and(
          eq(productRepositories.workspaceId, workspaceId),
          eq(productRepositories.productId, productId),
        ),
      )
      .orderBy(desc(productRepositories.isDefault));
    const picked = pickRepo(mapped);
    if (picked) return picked;
    if (mapped.length > 1) throw ambiguous(mapped, "this card's product");
  }

  // 3. Any repo in the workspace.
  const all = await db
    .select(REPO_COLUMNS)
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId));
  const picked = pickRepo(all);
  if (picked) return picked;
  if (all.length > 1) throw ambiguous(all, "this workspace");

  throw new GithubNotConfiguredError(
    "GitHub linking requires a connected repository. Connect one under " +
      "Settings > Integrations > Repositories first.",
  );
}

/** Split `owner/name`, rejecting anything else. */
export function splitRepoSlug(slug: string): [string, string] {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new InvalidGithubLinkError(
      `repo must be in "owner/name" form; got "${slug}".`,
    );
  }
  return [parts[0].trim(), parts[1].trim()];
}

/** The unambiguous choice from a tier: the only one, or the spec repo. */
export function pickRepo<T extends { isSpecRepo: boolean }>(
  candidates: T[],
): T | null {
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) return null;
  return candidates.find((r) => r.isSpecRepo) ?? null;
}

/** Ask the caller to disambiguate, naming the repos they can choose from. */
function ambiguous(candidates: RepoCoords[], where: string): Error {
  const names = candidates.map(repoSlug).join(", ");
  return new InvalidGithubLinkError(
    `${where} has more than one connected repository (${names}). ` +
      `Pass repo: "owner/name" to say which one this link belongs to.`,
  );
}

/** Resolve a link's GitHub metadata (title/state/url) for caching. */
async function resolveMetadata(
  repo: RepoCoords,
  input: GithubLinkInput,
): Promise<GithubArtifactMeta> {
  const db = getDb()!;
  const app = await getGithubApp(db);
  if (!app) {
    throw new GithubNotConfiguredError("GitHub App is not configured.");
  }
  const client = await createGitHubRepoClient(app, {
    installationId: repo.installationId,
    owner: repo.owner,
    name: repo.name,
    ref: repo.defaultBranch,
  });
  try {
    if (input.kind === "branch") return await client.getBranch(input.branch!);
    if (input.kind === "issue") return await client.getIssue(input.number!);
    return await client.getPullRequest(input.number!);
  } catch (err) {
    if (isNotFound(err)) {
      throw new InvalidGithubLinkError(
        `That ${input.kind.replace("_", " ")} was not found in ${repo.owner}/${repo.name}.`,
      );
    }
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    err.status === 404
  );
}

/** Create a GitHub link on `specId`; returns the feature's refreshed links. */
export async function addFeatureGithubLink(
  specId: string,
  input: GithubLinkInput,
  scope?: WorkspaceScope,
): Promise<GithubLink[]> {
  if (!scope) {
    throw new GithubNotConfiguredError(
      "GitHub linking requires a connected repository.",
    );
  }
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);

  // A missing repo is a configuration problem, not a missing item: resolve
  // throws GithubNotConfiguredError / InvalidGithubLinkError with an actionable
  // message. (This used to surface as "Unknown feature", because a DB-native
  // card has no repoId of its own and the lookup was an inner join.)
  const repo = await resolveFeatureRepo(
    specId,
    scope.workspaceId,
    feature.productId,
    input.repo,
  );

  const meta = await resolveMetadata(repo, input);
  const resolved: ResolvedGithubLink = {
    repoId: repo.repoId,
    kind: input.kind,
    number: input.kind === "branch" ? null : (input.number ?? null),
    branch: input.kind === "branch" ? (input.branch ?? null) : null,
    url: meta.url,
    title: meta.title,
    state: meta.state,
  };

  await store.addGithubLink(specId, resolved, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.githubLinks ?? [];
}

/**
 * Record a pull request Specboards itself just opened (or just added a commit
 * to) against the item whose spec it proposes a change to.
 *
 * Unlike {@link addFeatureGithubLink} this does not read the pull request back
 * from GitHub: the write returned its number and url, we wrote its title, and
 * it is open by construction. Skipping the round trip keeps a spec save at one
 * GitHub conversation, and keeps this path working under the E2E fake, which
 * stands in for the repo client but not for the App.
 *
 * Idempotent: the store upserts on (item, url), so a second edit joining the
 * same pull request refreshes the link rather than stacking duplicates.
 */
export async function recordWritePullRequest(
  specId: string,
  repoId: string,
  pull: { number: number; url: string },
  title: string,
  scope: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.addGithubLink(
    specId,
    {
      repoId,
      kind: "pull_request",
      number: pull.number,
      branch: null,
      url: pull.url,
      title,
      state: "open",
    },
    scope,
  );
}

/** Remove a GitHub link by id; returns the feature's refreshed links. */
export async function removeFeatureGithubLink(
  specId: string,
  linkId: string,
  scope?: WorkspaceScope,
): Promise<GithubLink[]> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);
  await store.removeGithubLink(specId, linkId, scope);
  const updated = await store.getFeature(specId, scope);
  return updated?.githubLinks ?? [];
}
