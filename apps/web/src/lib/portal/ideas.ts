import {
  and,
  asc,
  count,
  eq,
  ideaStatuses,
  ideaVotes,
  ideas,
  inArray,
  products,
} from "@specboards/db";
import { resolveIdeaStages, type IdeaStage } from "@specboards/core";

import { getPortalDb } from "@/lib/db";
import { isLocalFileMode } from "@/lib/local-mode";
import { getStore } from "@/lib/store";

import type { PortalContext } from "./resolve";

/**
 * What an outsider may know about an idea.
 *
 * ── This projection IS the security boundary ───────────────────────────────
 * Deliberately a separate type built by a separate query, rather than
 * `IdeaRecord` with the sensitive fields dropped at the view layer. The two
 * approaches look equivalent and fail very differently:
 *
 * - Filtering an internal record at the view means the private fields are
 *   present in memory on a public page, one careless `{...idea}` or one added
 *   `<pre>{JSON.stringify(idea)}</pre>` away from being rendered, and a field
 *   added to `IdeaRecord` next year is published by default.
 * - A projection cannot leak a field it never selected. A new column on `ideas`
 *   is absent here until somebody adds it on purpose, which is the direction a
 *   public surface should fail in.
 *
 * So the fields below are the whole list, and each omission is deliberate:
 *
 * - `authorId` / `authorName`: which employee captured an idea is internal.
 * - `promotedFeatureId` and the promoted feature's title: the backlog item an
 *   idea became is unannounced roadmap, and the title is often the giveaway.
 * - `submitterEmail`: someone else's address, and the portal is the surface it
 *   would be published on.
 * - `productId`: the portal publishes a product set, not a per-idea attribution,
 *   and an id is a handle for probing what else exists.
 * - `viewerHasVoted`: there is no viewer identity here. Whether the person
 *   reading has voted is answered by the vote cookie, not by the read model,
 *   because answering it in SQL would mean this query knowing who they are.
 */
export interface PortalIdea {
  id: string;
  title: string;
  /** Free-form detail (Markdown), or null. */
  description: string | null;
  /** Published stage key. Paired with `statusLabel` for display. */
  status: string;
  /** The stage's human label, as the workspace named it. */
  statusLabel: string;
  /** Who submitted it, when they gave a name and are external. Never an email. */
  submitterName: string | null;
  voteCount: number;
  createdAt: string;
}

/** A published stage, for the list's filter. */
export interface PortalStage {
  key: string;
  label: string;
}

/**
 * The stages this portal publishes, in workflow order, with their labels.
 *
 * Read from `idea_statuses` where the workspace has customised its workflow,
 * and from the built-in defaults where it has not: `resolveIdeaStages` treats
 * fewer than two rows as "not customised", so for most workspaces the labels
 * exist only in code. Both paths are then narrowed to `portalIdeaStatuses`,
 * which is the admin's published set.
 *
 * A key in that array matching no stage at all contributes nothing, which is
 * how a renamed-away stage fails safe (0008 chose text keys over a foreign key
 * knowing this would happen).
 */
function publishedStages(
  settings: PortalContext["settings"],
  rows: readonly IdeaStage[],
): PortalStage[] {
  const published = new Set(settings.portalIdeaStatuses);
  return resolveIdeaStages(rows)
    .filter((s) => published.has(s.key))
    .map((s) => ({ key: s.key, label: s.label }));
}

/** Newest first within equal demand, which is how a feedback board reads. */
function byDemandThenRecency(a: PortalIdea, b: PortalIdea): number {
  return (
    b.voteCount - a.voteCount ||
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
  );
}

/**
 * Everything the ideas list renders, in one round trip per source.
 *
 * Not exported: every caller destructures it off `listPortalIdeas`, so the name
 * is never written down elsewhere and `knip` correctly flags an exported
 * version as dead. The two members ARE exported, because pages and components
 * name those in their own props.
 */
interface PortalIdeaList {
  ideas: PortalIdea[];
  stages: PortalStage[];
}

/**
 * The published ideas for a portal, with their vote counts and stage labels.
 *
 * Runs on `getPortalDb()`, where RLS has already limited every table to what
 * the workspace publishes. The `workspaceId` predicates below are therefore the
 * belt beside those braces rather than the enforcement: they keep one portal
 * from rendering another's ideas, which is an application concern (see 0009 on
 * why the role can read every published workspace and why that is the right
 * split).
 */
export async function listPortalIdeas(
  portal: PortalContext,
): Promise<PortalIdeaList> {
  if (isLocalFileMode()) return listLocalPortalIdeas(portal);

  const db = getPortalDb();
  if (!db) return { ideas: [], stages: [] };

  const { workspaceId, settings } = portal;
  // An empty published set means an unfinished portal, not an error, and
  // `inArray(..., [])` is a query worth not issuing.
  if (settings.portalIdeaStatuses.length === 0) {
    return { ideas: [], stages: [] };
  }

  const [rows, stageRows] = await Promise.all([
    db
      .select({
        id: ideas.id,
        title: ideas.title,
        description: ideas.description,
        status: ideas.status,
        submitterName: ideas.submitterName,
        createdAt: ideas.createdAt,
      })
      .from(ideas)
      .where(
        and(
          eq(ideas.workspaceId, workspaceId),
          inArray(ideas.status, settings.portalIdeaStatuses),
        ),
      ),
    db
      .select({
        key: ideaStatuses.key,
        label: ideaStatuses.label,
        position: ideaStatuses.position,
      })
      .from(ideaStatuses)
      .where(eq(ideaStatuses.workspaceId, workspaceId))
      .orderBy(asc(ideaStatuses.position)),
  ]);

  const counts = await voteCounts(
    db,
    rows.map((r) => r.id),
  );

  return {
    ideas: rows
      .map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        statusLabel: labelFor(r.status, settings, stageRows),
        submitterName: r.submitterName,
        voteCount: counts.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
      }))
      .sort(byDemandThenRecency),
    stages: publishedStages(settings, stageRows),
  };
}

/**
 * One published idea, or null.
 *
 * Null covers "no such idea" and "that idea is not published" without
 * distinguishing them, for the same reason `resolvePortal` refuses to
 * distinguish its three cases: an id is guessable in bulk, and a detail route
 * that answered differently would confirm which ids name real internal ideas.
 * On the hosted path the distinction cannot be made even deliberately, because
 * an unpublished idea is not a row this connection can see.
 */
export async function readPortalIdea(
  portal: PortalContext,
  ideaId: string,
): Promise<PortalIdea | null> {
  if (isLocalFileMode()) {
    const { ideas: all } = await listLocalPortalIdeas(portal);
    return all.find((i) => i.id === ideaId) ?? null;
  }

  const db = getPortalDb();
  if (!db) return null;

  const { workspaceId, settings } = portal;
  if (settings.portalIdeaStatuses.length === 0) return null;

  const [row] = await db
    .select({
      id: ideas.id,
      title: ideas.title,
      description: ideas.description,
      status: ideas.status,
      submitterName: ideas.submitterName,
      createdAt: ideas.createdAt,
    })
    .from(ideas)
    .where(
      and(
        eq(ideas.id, ideaId),
        eq(ideas.workspaceId, workspaceId),
        inArray(ideas.status, settings.portalIdeaStatuses),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [stageRows, counts] = await Promise.all([
    db
      .select({
        key: ideaStatuses.key,
        label: ideaStatuses.label,
        position: ideaStatuses.position,
      })
      .from(ideaStatuses)
      .where(eq(ideaStatuses.workspaceId, workspaceId))
      .orderBy(asc(ideaStatuses.position)),
    voteCounts(db, [row.id]),
  ]);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    statusLabel: labelFor(row.status, settings, stageRows),
    submitterName: row.submitterName,
    voteCount: counts.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A product this portal publishes, for the submission form's picker. */
export interface PortalProduct {
  id: string;
  name: string;
}

/**
 * The products this portal publishes, by name.
 *
 * Only the submission form needs these: a portal can publish several backlogs,
 * and filing a stranger's idea against whichever happened to be first is how
 * feedback ends up on the wrong board. The list view deliberately does NOT show
 * a product per idea (the projection omits `productId` entirely), so this is
 * not a way in to that.
 *
 * Read on the portal connection like everything else, where
 * `products_portal_select` admits only published products, so an unannounced
 * product's name cannot reach the picker even if `portalProductIds` were wrong.
 */
export async function listPortalProducts(
  portal: PortalContext,
): Promise<PortalProduct[]> {
  const ids = portal.settings.portalProductIds;
  if (ids.length === 0) return [];

  if (isLocalFileMode()) {
    const store = await getStore();
    const all = await store.listProducts();
    return all
      .filter((p) => ids.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name }));
  }

  const db = getPortalDb();
  if (!db) return [];
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(
      and(
        eq(products.workspaceId, portal.workspaceId),
        inArray(products.id, ids),
      ),
    );
  // Ordered by the published set rather than by name, so the picker's order is
  // the admin's and does not shuffle when a product is renamed.
  return ids.flatMap((id) => rows.filter((r) => r.id === id));
}

/** Vote counts by idea id. Counts rows and reads no voter identity. */
async function voteCounts(
  db: NonNullable<ReturnType<typeof getPortalDb>>,
  ideaIds: string[],
): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map();
  // `count()` and nothing else. `voter_email` is not a column this connection
  // may name at all (0010), so a `select *` here would not merely be sloppy, it
  // would fail with a permission error. That is the intended design and not a
  // constraint to work around.
  const rows = await db
    .select({ ideaId: ideaVotes.ideaId, n: count() })
    .from(ideaVotes)
    .where(inArray(ideaVotes.ideaId, ideaIds))
    .groupBy(ideaVotes.ideaId);
  return new Map(rows.map((r) => [r.ideaId, Number(r.n)] as const));
}

function labelFor(
  status: string,
  settings: PortalContext["settings"],
  rows: readonly IdeaStage[],
): string {
  return (
    publishedStages(settings, rows).find((s) => s.key === status)?.label ??
    status
  );
}

/**
 * Local file mode: one workspace, no Postgres, no RLS, bound to loopback.
 *
 * `resolvePortal` explains why the portal reads the local store here like
 * everything else does. The projection still applies in full, so a self-hoster
 * previewing their portal sees exactly what a visitor would rather than a
 * looser local-only version of it, and this path cannot become the one where a
 * field quietly leaks.
 */
async function listLocalPortalIdeas(
  portal: PortalContext,
): Promise<PortalIdeaList> {
  const store = await getStore();
  const { settings } = portal;
  const published = new Set(settings.portalIdeaStatuses);
  const publishedProducts = new Set(settings.portalProductIds);

  const [all, stageRows] = await Promise.all([
    store.listIdeas(),
    store.listIdeaStatuses(),
  ]);

  return {
    ideas: all
      .filter(
        (i) =>
          // The moderation state, checked FIRST because it is the one term with
          // no database behind it here. On the hosted path
          // `specboards_portal_shows_idea` refuses a pending or hidden idea
          // whatever this function does; local mode has no RLS, so this line is
          // the only thing standing between a rejected submission and the
          // preview a self-hoster is using to decide what their portal shows.
          i.portalVisibility === "published" &&
          published.has(i.status) &&
          // An idea whose product was deleted has a null product id and is in
          // no published set, so it is not published. Mirrors the null handling
          // in `specboards_portal_shows_idea`, which is easy to lose by writing
          // the test the other way round.
          i.productId !== null &&
          publishedProducts.has(i.productId),
      )
      .map((i) => ({
        id: i.id,
        title: i.title,
        description: i.description,
        status: i.status,
        statusLabel: labelFor(i.status, settings, stageRows),
        submitterName: i.submitterName,
        voteCount: i.voteCount,
        createdAt: i.createdAt,
      }))
      .sort(byDemandThenRecency),
    stages: publishedStages(settings, stageRows),
  };
}
