import {
  and,
  asc,
  eq,
  features,
  inArray,
  isNull,
  or,
  releases,
  workspaceLevels,
  workspaceStatuses,
} from "@specboards/db";
import { DEFAULT_STATUSES, terminalStatus } from "@specboards/core";

import { getPortalDb } from "@/lib/db";
import { isLocalFileMode } from "@/lib/local-mode";
import { compareShippedReleases } from "@/lib/store/types";
import { getStore } from "@/lib/store";

import type { PortalContext } from "./resolve";

/**
 * The public roadmap: releases, and the work scheduled into them.
 *
 * Purpose-built rather than a reuse of the internal roadmap page, and the
 * difference is what it refuses to say. Internally a roadmap item carries an
 * assignee, RICE scores, custom fields, tags and child counts, all of which are
 * how a team runs itself and none of which is a customer's business.
 */

/** One item on the public roadmap. The whole shape, deliberately. */
export interface PortalRoadmapItem {
  id: string;
  title: string;
  /** The workspace's own name for this level ("Feature", "Epic"). */
  levelLabel: string;
  /** Coarse public phase. Never the internal stage name. See `publicPhase`. */
  phase: PublicPhase;
}

/** One release, with what is scheduled into it. */
export interface PortalRelease {
  id: string;
  name: string;
  /** Target date as stored (date-only), or null. */
  targetDate: string | null;
  /** Actual ship date, or null when not shipped. */
  shippedDate: string | null;
  items: PortalRoadmapItem[];
}

/**
 * Not exported: the page destructures it off `readPortalRoadmap`, so the name
 * is never written down elsewhere. `PortalRelease` is exported, because the
 * page's `Section` names it in its props.
 */
interface PortalRoadmap {
  /** Newest-shipped first. */
  shipped: PortalRelease[];
  /** Soonest first: what is coming, in the order it is coming. */
  upcoming: PortalRelease[];
}

/**
 * The three phases a public roadmap admits to.
 *
 * ── Why not the workspace's own status label ───────────────────────────────
 * Because it is internal vocabulary and it is frequently unflattering.
 * `blocked`, `in_review`, `needs_design` and `waiting_on_legal` are all real
 * things to call a stage and none of them is something a customer should read
 * about the feature they asked for. The admin already chooses WHICH statuses
 * appear (`portal_roadmap_item_statuses`); this decides how they are NAMED.
 *
 * ── Why the mapping is positional ──────────────────────────────────────────
 * The workflow is workspace-defined, so there is no fixed set of keys to map
 * from: one team's `done` is another's `released` is another's `live`. What
 * every workflow does have is an order, and `terminalStatus` in core already
 * relies on exactly that ("a team renames the vocabulary in Settings and
 * nothing records which of their stages means the work is over. Position
 * does."). This uses the same reasoning rather than inventing a second one.
 *
 * First stage means not started, the last non-archived stage means finished,
 * and everything between is under way.
 */
type PublicPhase = "planned" | "in_progress" | "shipped";

export const PUBLIC_PHASE_LABEL: Record<PublicPhase, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/**
 * The workflow order to measure against.
 *
 * A workspace that has never customised its workflow has no `workspace_statuses`
 * rows at all, exactly as it has no `idea_statuses` rows, so the built-in order
 * is the real one for most workspaces and exists only in code. Falling back to
 * it keeps the common case correct without a row having to exist.
 */
function orderedStatusKeys(rows: readonly string[]): readonly string[] {
  return rows.length >= 2 ? rows : DEFAULT_STATUSES;
}

/** Map one internal status key onto the public vocabulary. */
export function publicPhase(
  status: string,
  orderedStatuses: readonly string[],
): PublicPhase {
  const end = terminalStatus(orderedStatuses);
  if (end && status === end) return "shipped";
  const index = orderedStatuses.indexOf(status);
  // Unknown key, or the very first stage. Unknown lands on `planned` on
  // purpose: it is the least-committal thing to say about work whose stage we
  // cannot place, and the alternative would be announcing something as
  // delivered on the strength of a key nobody recognises.
  if (index <= 0) return "planned";
  return "in_progress";
}

/**
 * The published roadmap for a portal.
 *
 * Runs on `getPortalDb()`. RLS already refuses every release when the roadmap
 * switch is off, and every item outside the published products and statuses
 * (`releases_portal_select` / `features_portal_select`, migration 0009), so the
 * predicates here keep one portal from rendering another's rather than being
 * the enforcement.
 */
export async function readPortalRoadmap(
  portal: PortalContext,
): Promise<PortalRoadmap> {
  const { settings, workspaceId } = portal;
  if (
    !settings.portalRoadmapEnabled ||
    settings.portalRoadmapItemStatuses.length === 0 ||
    settings.portalProductIds.length === 0
  ) {
    return { shipped: [], upcoming: [] };
  }

  if (isLocalFileMode()) return localRoadmap(portal);

  const db = getPortalDb();
  if (!db) return { shipped: [], upcoming: [] };

  const [releaseRows, itemRows, levelRows, statusRows] = await Promise.all([
    db
      .select({
        id: releases.id,
        name: releases.name,
        status: releases.status,
        targetDate: releases.targetDate,
        shippedDate: releases.shippedDate,
      })
      .from(releases)
      .where(
        and(
          eq(releases.workspaceId, workspaceId),
          // A release belongs to one product or to none (a portfolio release
          // spanning every product). Publishing a portfolio release is correct
          // when any product is published, which is guaranteed above.
          or(
            isNull(releases.productId),
            inArray(releases.productId, settings.portalProductIds),
          ),
        ),
      ),
    db
      .select({
        id: features.id,
        title: features.title,
        level: features.level,
        status: features.status,
        releaseId: features.releaseId,
      })
      .from(features)
      .where(
        and(
          eq(features.workspaceId, workspaceId),
          inArray(features.status, settings.portalRoadmapItemStatuses),
        ),
      ),
    db
      .select({
        key: workspaceLevels.key,
        label: workspaceLevels.label,
        position: workspaceLevels.position,
      })
      .from(workspaceLevels)
      .where(eq(workspaceLevels.workspaceId, workspaceId))
      .orderBy(asc(workspaceLevels.position)),
    // The workflow ORDER, and only the order: `label` is not a column this
    // connection may name (0013), which is the point. The workspace default
    // (`product_id is null`) is what the roadmap uses, because it spans
    // products and a per-product override would give one release two different
    // orderings.
    db
      .select({ key: workspaceStatuses.key, position: workspaceStatuses.position })
      .from(workspaceStatuses)
      .where(
        and(
          eq(workspaceStatuses.workspaceId, workspaceId),
          isNull(workspaceStatuses.productId),
        ),
      )
      .orderBy(asc(workspaceStatuses.position)),
  ]);

  return assemble(
    releaseRows,
    itemRows,
    new Map(levelRows.map((l) => [l.key, l.label] as const)),
    orderedStatusKeys(statusRows.map((r) => r.key)),
  );
}

/** Shared by both modes, so neither can drift on grouping or ordering. */
function assemble(
  releaseRows: {
    id: string;
    name: string;
    status: string;
    targetDate: string | null;
    shippedDate: string | null;
  }[],
  itemRows: {
    id: string;
    title: string;
    level: string;
    status: string;
    releaseId: string | null;
  }[],
  levelLabels: Map<string, string>,
  orderedStatuses: readonly string[],
): PortalRoadmap {
  const byRelease = new Map<string, PortalRoadmapItem[]>();
  for (const item of itemRows) {
    // An item scheduled into no release is not on a roadmap. It is backlog, and
    // publishing it would turn the roadmap into a list of everything the team
    // has ever considered.
    if (!item.releaseId) continue;
    const list = byRelease.get(item.releaseId) ?? [];
    list.push({
      id: item.id,
      title: item.title,
      levelLabel: levelLabels.get(item.level) ?? item.level,
      phase: publicPhase(item.status, orderedStatuses),
    });
    byRelease.set(item.releaseId, list);
  }

  const withItems = releaseRows
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      targetDate: r.targetDate,
      shippedDate: r.shippedDate,
      items: byRelease.get(r.id) ?? [],
    }))
    // A release with nothing published in it says nothing and takes up a
    // heading. It is also a small leak of its own: an empty release name
    // announces something planned with no visible content.
    .filter((r) => r.items.length > 0);

  const shipped = withItems
    .filter((r) => r.status === "shipped")
    // `compareShippedReleases` already encodes newest-first, and the reasoning
    // for it (the latest release is what people most want to reach, so it
    // should not sit at the far end of a long history) applies at least as
    // strongly to a public page as to the internal one.
    .sort(compareShippedReleases);

  const upcoming = withItems
    .filter((r) => r.status !== "shipped")
    // The inverse: soonest first, because the question a visitor is asking is
    // "when do I get this", and undated last because a release with no date
    // answers it least.
    .sort((a, b) => {
      if (a.targetDate === b.targetDate) return a.name.localeCompare(b.name);
      if (a.targetDate === null) return 1;
      if (b.targetDate === null) return -1;
      return a.targetDate < b.targetDate ? -1 : 1;
    });

  const strip = (r: (typeof withItems)[number]): PortalRelease => ({
    id: r.id,
    name: r.name,
    targetDate: r.targetDate,
    shippedDate: r.shippedDate,
    items: r.items,
  });

  return { shipped: shipped.map(strip), upcoming: upcoming.map(strip) };
}

/**
 * Local file mode: one workspace, no Postgres, no RLS.
 *
 * The published-product and published-status filters are applied here in code,
 * because on this path there is no database policy behind them. Same shape as
 * the portal ideas read model, and the same reason.
 */
async function localRoadmap(portal: PortalContext): Promise<PortalRoadmap> {
  const { settings } = portal;
  const store = await getStore();
  const [releaseList, items, levels, statuses] = await Promise.all([
    store.listReleases(),
    store.listFeatures(),
    store.listLevels(),
    store.listStatuses(),
  ]);

  const publishedProducts = new Set(settings.portalProductIds);
  const publishedStatuses = new Set(settings.portalRoadmapItemStatuses);

  return assemble(
    releaseList
      .filter((r) => r.productId === null || publishedProducts.has(r.productId))
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        targetDate: r.targetDate,
        shippedDate: r.shippedDate,
      })),
    items
      .filter(
        (f) =>
          publishedStatuses.has(f.status) &&
          f.productId !== null &&
          publishedProducts.has(f.productId),
      )
      .map((f) => ({
        id: f.specId,
        title: f.title,
        level: f.level,
        status: f.status,
        releaseId: f.releaseId,
      })),
    new Map(levels.map((l) => [l.key, l.label] as const)),
    orderedStatusKeys(statuses.map((st) => st.key)),
  );
}
