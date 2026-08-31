/**
 * Ideas and their settings, in local file mode.
 *
 * Mirrors db/ideas.ts, including the part that makes ideas unusual: promoting
 * one creates a real work item, so this module reaches across to the item
 * writer rather than duplicating what creating an item means. The settings live
 * here for the same reason they do on the Postgres side, decided in the step
 * that moved them: they are idea configuration.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type IdeaStage,
  promotedIdeaStatus,
  resolveIdeaStages,
  resolveLevels,
} from "@specboards/core";

import {
  type FeatureRecord,
  IdeaError,
  type IdeaInput,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaSettings,
  type IdeaSettingsPatch,
  type StatusStageInput,
  type WorkspaceScope,
} from "../types";

import { type LocalStoreContext } from "./context";
import { createFeature } from "./items-write";
import { localPath } from "./paths";
import { LOCAL_USER } from "./types";

export async function listIdeas(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<IdeaRecord[]> {
  const [rows, all] = await Promise.all([readIdeas(ctx), ctx.loadAll()]);
  const titleBySpec = new Map(all.map((f) => [f.specId, f.title] as const));
  return rows
    .map((r) =>
      toIdeaRecord(
        r,
        r.promotedFeatureSpecId
          ? (titleBySpec.get(r.promotedFeatureSpecId) ?? null)
          : null,
      ),
    )
    .sort(
      (a, b) =>
        b.voteCount - a.voteCount ||
        (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    );
}

export async function createIdea(
  ctx: LocalStoreContext,
  input: IdeaInput,
  _scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const title = input.title.trim();
  if (!title) throw new IdeaError("Idea title is required.");
  const productId = input.productId ?? (await ctx.defaultProductId());
  const idea: LocalIdea = {
    id: randomUUID(),
    title,
    description: input.description?.trim() ? input.description.trim() : null,
    status: "new",
    productId,
    submitterName: null,
    promotedFeatureSpecId: null,
    voters: [],
    createdAt: new Date().toISOString(),
  };
  const rows = await readIdeas(ctx);
  await writeIdeas(ctx, [...rows, idea]);
  return toIdeaRecord(idea, null);
}

export async function updateIdea(
  ctx: LocalStoreContext,
  id: string,
  patch: IdeaPatch,
  _scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const rows = await readIdeas(ctx);
  const idea = rows.find((r) => r.id === id);
  if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new IdeaError("Idea title is required.");
    idea.title = title;
  }
  if (patch.description !== undefined) {
    idea.description = patch.description?.trim()
      ? patch.description.trim()
      : null;
  }
  if (patch.status !== undefined) {
    const stages = resolveIdeaStages(await readIdeaStages(ctx));
    if (!stages.some((s) => s.key === patch.status)) {
      throw new IdeaError(`Unknown idea status: ${patch.status}`);
    }
    idea.status = patch.status;
  }
  if (patch.productId !== undefined) {
    idea.productId = patch.productId ?? (await ctx.defaultProductId());
  }
  await writeIdeas(ctx, rows);
  const title = idea.promotedFeatureSpecId
    ? ((await ctx.loadAll()).find(
        (f) => f.specId === idea.promotedFeatureSpecId,
      )?.title ?? null)
    : null;
  return toIdeaRecord(idea, title);
}

export async function deleteIdea(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readIdeas(ctx);
  if (!rows.some((r) => r.id === id))
    throw new IdeaError(`Unknown idea: ${id}`);
  await writeIdeas(
    ctx,
    rows.filter((r) => r.id !== id),
  );
}

export async function voteIdea(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const rows = await readIdeas(ctx);
  const idea = rows.find((r) => r.id === id);
  if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
  if (!idea.voters.includes(LOCAL_USER)) idea.voters.push(LOCAL_USER);
  await writeIdeas(ctx, rows);
  return toIdeaRecord(idea, null);
}

export async function unvoteIdea(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<IdeaRecord> {
  const rows = await readIdeas(ctx);
  const idea = rows.find((r) => r.id === id);
  if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
  idea.voters = idea.voters.filter((v) => v !== LOCAL_USER);
  await writeIdeas(ctx, rows);
  return toIdeaRecord(idea, null);
}

export async function promoteIdea(
  ctx: LocalStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const rows = await readIdeas(ctx);
  const idea = rows.find((r) => r.id === id);
  if (!idea) throw new IdeaError(`Unknown idea: ${id}`);
  if (idea.promotedFeatureSpecId) {
    throw new IdeaError("This idea has already been promoted.");
  }
  const levels = resolveLevels();
  const target = [...levels].reverse().find((l) => !l.isLeaf);
  if (!target) {
    throw new IdeaError(
      "This workspace has no non-leaf level to promote an idea into.",
    );
  }
  const feature = await createFeature(
    ctx,
    {
      title: idea.title,
      level: target.key,
      productId: idea.productId,
      details: idea.description,
    },
    scope,
  );
  const stages = resolveIdeaStages(await readIdeaStages(ctx));
  idea.promotedFeatureSpecId = feature.specId;
  idea.status = promotedIdeaStatus(idea.status, stages);
  await writeIdeas(ctx, rows);
  return { idea: toIdeaRecord(idea, feature.title), feature };
}

export async function listIdeaStatuses(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  return readIdeaStages(ctx);
}

export async function replaceIdeaStatuses(
  ctx: LocalStoreContext,
  stages: StatusStageInput[],
  _scope?: WorkspaceScope,
): Promise<IdeaStage[]> {
  const rows: IdeaStage[] = stages.map((s, i) => ({
    key: s.key,
    label: s.label,
    position: i,
  }));
  const validKeys = new Set(rows.map((r) => r.key));
  const fallback = rows[0]?.key;
  // Re-home orphaned ideas onto the first stage, mirroring the DB store.
  if (fallback) {
    const ideas = await readIdeas(ctx);
    let changed = false;
    for (const idea of ideas) {
      if (!validKeys.has(idea.status)) {
        idea.status = fallback;
        changed = true;
      }
    }
    if (changed) await writeIdeas(ctx, ideas);
  }
  await fs.mkdir(path.dirname(localPath(ctx.root, "ideaStatuses")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "ideaStatuses"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
  return rows;
}

export async function getIdeaSettings(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  try {
    const row = JSON.parse(
      await fs.readFile(localPath(ctx.root, "ideaSettings"), "utf8"),
    ) as LocalIdeaSettings;
    return {
      portalEnabled: row.portalEnabled ?? false,
      portalTitle: row.portalTitle ?? null,
    };
  } catch {
    return { portalEnabled: false, portalTitle: null };
  }
}

export async function updateIdeaSettings(
  ctx: LocalStoreContext,
  patch: IdeaSettingsPatch,
  _scope?: WorkspaceScope,
): Promise<IdeaSettings> {
  const current = await getIdeaSettings(ctx);
  const next: IdeaSettings = {
    portalEnabled: patch.portalEnabled ?? current.portalEnabled,
    portalTitle:
      patch.portalTitle !== undefined
        ? patch.portalTitle?.trim()
          ? patch.portalTitle.trim()
          : null
        : current.portalTitle,
  };
  await fs.mkdir(path.dirname(localPath(ctx.root, "ideaSettings")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "ideaSettings"),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
  return next;
}

// Ideas persist to `.specboards/local-ideas.json` (+ statuses/settings files).
async function readIdeas(ctx: LocalStoreContext): Promise<LocalIdea[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "ideas"), "utf8"),
    ) as LocalIdea[];
  } catch {
    return [];
  }
}

async function writeIdeas(
  ctx: LocalStoreContext,
  rows: LocalIdea[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "ideas")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "ideas"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

function toIdeaRecord(
  row: LocalIdea,
  promotedTitle: string | null,
): IdeaRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    productId: row.productId,
    authorName: null,
    submitterName: row.submitterName,
    voteCount: row.voters.length,
    viewerHasVoted: row.voters.includes(LOCAL_USER),
    promotedFeatureSpecId: row.promotedFeatureSpecId,
    promotedFeatureTitle: promotedTitle,
    createdAt: row.createdAt,
  };
}

async function readIdeaStages(ctx: LocalStoreContext): Promise<IdeaStage[]> {
  try {
    const rows = JSON.parse(
      await fs.readFile(localPath(ctx.root, "ideaStatuses"), "utf8"),
    ) as IdeaStage[];
    return rows
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((r, i) => ({ ...r, position: i }));
  } catch {
    return [];
  }
}

/** An idea / feature request persisted in local file mode. */
interface LocalIdea {
  id: string;
  title: string;
  description: string | null;
  status: string;
  productId: string | null;
  submitterName: string | null;
  /** Feature specId this idea was promoted into, or null. */
  promotedFeatureSpecId: string | null;
  /** User ids that voted; local mode has a single user (LOCAL_USER). */
  voters: string[];
  createdAt: string;
}

/** Ideas configuration persisted in local file mode. */
interface LocalIdeaSettings {
  portalEnabled: boolean;
  portalTitle: string | null;
}
