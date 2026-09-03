/**
 * Items: the read side.
 *
 * Three methods and most of the store's query weight, because an item is a
 * join of nearly everything else: its level, its product, its relations, its
 * GitHub links, its parent and children, its custom fields.
 *
 * The rule that shapes all three is the same one the rest of the store
 * follows: a row the caller cannot read is filtered out, not refused. What is
 * specific here is how far that reaches. An item's *relations* can point at
 * items in products the caller cannot see, so the edges are filtered while the
 * item stays visible, and its child list is filtered the same way. The counts
 * beside them are computed after filtering, so nothing leaks through an
 * arithmetic difference.
 *
 * Kept apart from the write side (./items-write.ts, once it moves) because
 * they are apart in the interface: `ItemReadStore` is what a page renderer
 * needs and nothing here mutates.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import { extractSections } from "@specboards/core";

import { riceFields } from "@/lib/feature-helpers";

import {
  and,
  eq,
  featureGithubLinks,
  featureLinks,
  features,
  inArray,
  or,
  releases,
  users,
} from "@specboards/db";

import type {
  FeatureDetail,
  FeatureRecord,
  FeatureRelation,
  GithubLink,
  GithubLinkAggregate,
  GithubLinkKind,
  RelationDirection,
  WorkspaceScope,
} from "../types";

import {
  canReadProductId,
  emptyAgg,
  doneStatusesIn,
  toCustomFields,
  type DbStoreContext,
  type LinkRow,
} from "./context";
export async function listFeatures(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<FeatureRecord[]> {
  return ctx.scoped(scope, async (tx) => {
    const [allRows, access, productById] = await Promise.all([
      tx.query.features.findMany({
        where: eq(features.workspaceId, scope!.workspaceId),
        with: { index: true },
      }),
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, scope!.workspaceId),
    ]);
    const rows = allRows.filter((row) =>
      canReadProductId(access, productById, row.productId),
    );
    const visibleIds = new Set(rows.map((row) => row.id));
    const links = await tx
      .select({
        fromFeatureId: featureLinks.fromFeatureId,
        toFeatureId: featureLinks.toFeatureId,
      })
      .from(featureLinks)
      .where(
        and(
          eq(featureLinks.workspaceId, scope!.workspaceId),
          eq(featureLinks.type, "blocks"),
        ),
      );
    const visibleLinks = links.filter(
      (link) =>
        visibleIds.has(link.fromFeatureId) && visibleIds.has(link.toFeatureId),
    );
    // One pass over the visible `blocks` edges to tally counts per row.
    const blocks = new Map<string, number>();
    const blockedBy = new Map<string, number>();
    for (const l of visibleLinks) {
      blocks.set(l.fromFeatureId, (blocks.get(l.fromFeatureId) ?? 0) + 1);
      blockedBy.set(l.toFeatureId, (blockedBy.get(l.toFeatureId) ?? 0) + 1);
    }
    // Hierarchy roll-up from the visible workspace set.
    const done = await doneStatusesIn(tx, scope!.workspaceId);
    const specById = new Map(rows.map((r) => [r.id, r.specId]));
    const childCount = new Map<string, number>();
    const childDone = new Map<string, number>();
    for (const r of rows) {
      if (!r.parentId || !visibleIds.has(r.parentId)) continue;
      childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
      if (done.isDone(r.status, r.productId))
        childDone.set(r.parentId, (childDone.get(r.parentId) ?? 0) + 1);
    }
    // GitHub link aggregate, rolled up over each visible feature's subtree.
    const ghLinks = (
      await tx
        .select({
          featureId: featureGithubLinks.featureId,
          kind: featureGithubLinks.kind,
          state: featureGithubLinks.state,
        })
        .from(featureGithubLinks)
        .where(eq(featureGithubLinks.workspaceId, scope!.workspaceId))
    ).filter((link) => visibleIds.has(link.featureId));
    const parentOf = new Map(
      rows.map((r) => [
        r.id,
        r.parentId && visibleIds.has(r.parentId) ? r.parentId : null,
      ]),
    );
    const ghAgg = new Map<string, GithubLinkAggregate>();
    for (const r of rows) ghAgg.set(r.id, emptyAgg());
    for (const link of ghLinks) {
      const seen = new Set<string>();
      let cur: string | null = link.featureId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const agg = ghAgg.get(cur);
        if (agg) tallyLink(agg, link.kind, link.state);
        cur = parentOf.get(cur) ?? null;
      }
    }
    return rows.map((row) => ({
      specId: row.specId,
      title: row.title,
      level: row.level,
      // "No attached spec", derived from spec_index rather than repo_id: a
      // work item with no spec has no repo either, so the two only look alike
      // until human work items exist. See ADR 0003 D2.
      isDbNative: row.index == null,
      productId: row.productId,
      status: row.status,
      rank: row.rank,
      tags: row.tags,
      releaseId: row.releaseId,
      cycleId: row.cycleId,
      assigneeId: row.assigneeId,
      customFields: toCustomFields(row.customFields),
      ...riceFields({
        riceReach: row.riceReach,
        riceImpact: row.riceImpact,
        riceConfidence: row.riceConfidence,
        riceEffort: row.riceEffort,
      }),
      path: row.index?.path ?? "",
      blocksCount: blocks.get(row.id) ?? 0,
      blockedByCount: blockedBy.get(row.id) ?? 0,
      parentSpecId: row.parentId ? (specById.get(row.parentId) ?? null) : null,
      childCount: childCount.get(row.id) ?? 0,
      childDoneCount: childDone.get(row.id) ?? 0,
      githubSummary: ghAgg.get(row.id) ?? emptyAgg(),
    }));
  });
}

export async function listFeatureBodies(
  ctx: DbStoreContext,
  specIds: readonly string[],
  scope?: WorkspaceScope,
): Promise<Map<string, string>> {
  if (specIds.length === 0) return new Map();
  return ctx.scoped(scope, async (tx) => {
    const rows = await tx.query.features.findMany({
      where: and(
        eq(features.workspaceId, scope!.workspaceId),
        inArray(features.specId, [...specIds]),
      ),
      with: { index: true },
    });
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, scope!.workspaceId),
    ]);
    const out = new Map<string, string>();
    for (const row of rows) {
      // The same visibility decision `getFeature` makes, made here too rather
      // than trusted to the caller: this is a bulk read of item *content*, and
      // a product the caller cannot open must not leak through it.
      if (!canReadProductId(access, productById, row.productId)) continue;
      // Spec-backed items read their body from spec_index; DB-native items
      // keep it inline on features.details. Same resolution as getFeature.
      const content = row.index?.content ?? row.details ?? "";
      if (content) out.set(row.specId, content);
    }
    return out;
  });
}

export async function getFeature(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<FeatureDetail | null> {
  return ctx.scoped(scope, async (tx) => {
    const row = await tx.query.features.findFirst({
      where: and(
        eq(features.specId, specId),
        eq(features.workspaceId, scope!.workspaceId),
      ),
      with: { index: true },
    });
    if (!row) return null;
    const [access, productById] = await Promise.all([
      ctx.accessIn(tx, scope!),
      ctx.productVisibilityIn(tx, scope!.workspaceId),
    ]);
    if (!canReadProductId(access, productById, row.productId)) return null;
    // Spec-backed items read their body from spec_index; DB-native items
    // (initiatives/epics) keep it inline on features.details.
    const content = row.index?.content ?? row.details ?? "";
    // Resolve the assignee's display name (separate lookup, since there's no
    // features→users relation, and assignees are usually few).
    let assigneeName: string | null = null;
    if (row.assigneeId) {
      const assignee = await tx.query.users.findFirst({
        where: eq(users.id, row.assigneeId),
        columns: { name: true },
      });
      assigneeName = assignee?.name ?? null;
    }

    // Relations touching this feature (either end), resolved to its POV.
    const links = (await tx
      .select({
        id: featureLinks.id,
        fromFeatureId: featureLinks.fromFeatureId,
        toFeatureId: featureLinks.toFeatureId,
        type: featureLinks.type,
      })
      .from(featureLinks)
      .where(
        and(
          eq(featureLinks.workspaceId, scope!.workspaceId),
          or(
            eq(featureLinks.fromFeatureId, row.id),
            eq(featureLinks.toFeatureId, row.id),
          ),
        ),
      )) as LinkRow[];
    const otherIds = links.map((l) =>
      l.fromFeatureId === row.id ? l.toFeatureId : l.fromFeatureId,
    );
    const others = otherIds.length
      ? await tx
          .select({
            id: features.id,
            specId: features.specId,
            title: features.title,
            level: features.level,
            productId: features.productId,
            releaseId: features.releaseId,
          })
          .from(features)
          .where(
            and(
              eq(features.workspaceId, scope!.workspaceId),
              inArray(features.id, otherIds),
            ),
          )
      : [];
    const byId = new Map(
      others
        .filter((o) => canReadProductId(access, productById, o.productId))
        .map((o) => [o.id, o]),
    );
    // Name the releases the readable others sit in. Driven off `byId` rather
    // than `others` so an item the caller cannot read does not pull its release
    // into the query. Nothing would leak if it did, since that relation is
    // dropped below either way; this just keeps the second query to the rows
    // that can actually be rendered.
    const releaseIds = [
      ...new Set(
        [...byId.values()]
          .map((o) => o.releaseId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const releaseNameById = new Map(
      releaseIds.length
        ? (
            await tx
              .select({ id: releases.id, name: releases.name })
              .from(releases)
              .where(
                and(
                  eq(releases.workspaceId, scope!.workspaceId),
                  inArray(releases.id, releaseIds),
                ),
              )
          ).map((r) => [r.id, r.name])
        : [],
    );
    const relations: FeatureRelation[] = links
      .map((l) => {
        const otherId =
          l.fromFeatureId === row.id ? l.toFeatureId : l.fromFeatureId;
        const other = byId.get(otherId);
        if (!other) return null;
        // A release id whose row is missing resolves to no badge rather than a
        // named one, which is why the id is dropped alongside the name.
        const releaseName = other.releaseId
          ? (releaseNameById.get(other.releaseId) ?? null)
          : null;
        return {
          id: l.id,
          direction: directionFor(l, row.id),
          otherSpecId: other.specId,
          otherTitle: other.title,
          otherLevel: other.level,
          otherReleaseId: releaseName ? other.releaseId : null,
          otherReleaseName: releaseName,
        } satisfies FeatureRelation;
      })
      .filter((r): r is FeatureRelation => r !== null);

    // Parent (one lookup) + direct children for the hierarchy view.
    let parentSpecId: string | null = null;
    let parentTitle: string | null = null;
    if (row.parentId) {
      const parent = await tx.query.features.findFirst({
        where: and(
          eq(features.id, row.parentId),
          eq(features.workspaceId, scope!.workspaceId),
        ),
        columns: { specId: true, title: true, productId: true },
      });
      if (parent && canReadProductId(access, productById, parent.productId)) {
        parentSpecId = parent.specId;
        parentTitle = parent.title;
      }
    }
    const [childRowsRaw, done] = await Promise.all([
      tx
        .select({
          specId: features.specId,
          title: features.title,
          status: features.status,
          productId: features.productId,
        })
        .from(features)
        .where(
          and(
            eq(features.parentId, row.id),
            eq(features.workspaceId, scope!.workspaceId),
          ),
        ),
      doneStatusesIn(tx, scope!.workspaceId),
    ]);
    // Kept with `productId` for the roll-up below, which judges each child's
    // status against its own product's terminal stage; the shape the caller
    // sees drops it.
    const readableChildren = childRowsRaw.filter((child) =>
      canReadProductId(access, productById, child.productId),
    );
    const childRows = readableChildren.map(
      ({ productId: _productId, ...child }) => child,
    );

    // The whole workspace tree (id + parent), for the subtree walks below.
    const treeRows = await tx
      .select({
        id: features.id,
        parentId: features.parentId,
        productId: features.productId,
      })
      .from(features)
      .where(eq(features.workspaceId, scope!.workspaceId));
    const visibleTreeRows = treeRows.filter((r) =>
      canReadProductId(access, productById, r.productId),
    );
    const visibleIds = new Set(visibleTreeRows.map((r) => r.id));

    // GitHub links: this item's own + all descendants' (rolled up). Walk the
    // parent map down from `row.id` to collect the subtree feature ids.
    const childrenOf = new Map<string, string[]>();
    for (const r of visibleTreeRows) {
      if (!r.parentId || !visibleIds.has(r.parentId)) continue;
      (
        childrenOf.get(r.parentId) ??
        childrenOf.set(r.parentId, []).get(r.parentId)!
      ).push(r.id);
    }
    const subtree = new Set<string>([row.id]);
    const queue = [row.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (!subtree.has(child)) {
          subtree.add(child);
          queue.push(child);
        }
      }
    }
    const ghRows = await tx
      .select({
        id: featureGithubLinks.id,
        featureId: featureGithubLinks.featureId,
        kind: featureGithubLinks.kind,
        number: featureGithubLinks.number,
        branch: featureGithubLinks.branch,
        url: featureGithubLinks.url,
        title: featureGithubLinks.title,
        state: featureGithubLinks.state,
        headBranch: featureGithubLinks.headBranch,
      })
      .from(featureGithubLinks)
      .where(
        and(
          eq(featureGithubLinks.workspaceId, scope!.workspaceId),
          inArray(featureGithubLinks.featureId, [...subtree]),
        ),
      );
    const sourceInfo = ghRows.length
      ? await tx
          .select({
            id: features.id,
            specId: features.specId,
            title: features.title,
          })
          .from(features)
          .where(
            and(
              eq(features.workspaceId, scope!.workspaceId),
              inArray(features.id, [
                ...new Set(ghRows.map((l) => l.featureId)),
              ]),
            ),
          )
      : [];
    const sourceById = new Map(sourceInfo.map((s) => [s.id, s]));
    const githubLinks: GithubLink[] = ghRows.map((l) => ({
      id: l.id,
      kind: l.kind,
      number: l.number,
      branch: l.branch,
      url: l.url,
      title: l.title,
      state: l.state,
      headBranch: l.headBranch,
      sourceSpecId: sourceById.get(l.featureId)?.specId ?? row.specId,
      sourceTitle: sourceById.get(l.featureId)?.title ?? row.title,
      inherited: l.featureId !== row.id,
    }));
    const githubSummary = emptyAgg();
    for (const l of ghRows) tallyLink(githubSummary, l.kind, l.state);

    return {
      specId: row.specId,
      title: row.title,
      level: row.level,
      // See listFeatures: "no attached spec", not "no repo" (ADR 0003 D2).
      isDbNative: row.index == null,
      productId: row.productId,
      status: row.status,
      rank: row.rank,
      tags: row.tags,
      releaseId: row.releaseId,
      cycleId: row.cycleId,
      assigneeId: row.assigneeId,
      assigneeName,
      customFields: toCustomFields(row.customFields),
      ...riceFields({
        riceReach: row.riceReach,
        riceImpact: row.riceImpact,
        riceConfidence: row.riceConfidence,
        riceEffort: row.riceEffort,
      }),
      path: row.index?.path ?? "",
      content,
      blobSha: row.index?.blobSha ?? null,
      sections: extractSections(content),
      relations,
      blocksCount: relations.filter((r) => r.direction === "blocks").length,
      blockedByCount: relations.filter((r) => r.direction === "blocked_by")
        .length,
      parentSpecId,
      parentTitle,
      children: childRows,
      childCount: childRows.length,
      childDoneCount: readableChildren.filter((c) =>
        done.isDone(c.status, c.productId),
      ).length,
      githubSummary,
      githubLinks,
    };
  });
}

/** Resolve a stored link into the direction seen from `featureId`'s side. */
function directionFor(link: LinkRow, featureId: string): RelationDirection {
  const outgoing = link.fromFeatureId === featureId;
  switch (link.type) {
    case "blocks":
      return outgoing ? "blocks" : "blocked_by";
    case "duplicates":
      return outgoing ? "duplicates" : "duplicated_by";
    case "relates_to":
      return "relates_to";
  }
}

/** Tally one link into an aggregate (closed-not-merged PRs count in total only). */
function tallyLink(
  agg: GithubLinkAggregate,
  kind: GithubLinkKind,
  state: string | null,
): void {
  agg.total += 1;
  if (kind === "issue") agg.issues += 1;
  else if (kind === "branch") agg.branches += 1;
  else if (state === "merged") agg.mergedPrs += 1;
  else if (state === "open") agg.openPrs += 1;
}
