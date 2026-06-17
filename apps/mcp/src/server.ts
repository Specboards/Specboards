#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import { canTransition, rollUpEstimates } from "@specboard/core";
import {
  createDb,
  featureLinks,
  features,
  workspaces,
  type Database,
} from "@specboard/db";

/**
 * SpecBoard MCP server. Gives coding agents a prioritized, status-aware view of
 * specs: they see not just the markdown (canonical in git) but the metadata
 * (status, assignee, priority) layered on top from the DB.
 *
 * Requires DATABASE_URL (the same Postgres the web app uses).
 */
const server = new McpServer({ name: "specboard", version: "0.1.0" });

let dbInstance: Database | undefined;
function db(): Database {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Point it at the SpecBoard Postgres (e.g. postgres://postgres:postgres@localhost:5432/specboard) and seed it with `pnpm --filter @specboard/db seed`.",
      );
    }
    dbInstance = createDb(url);
  }
  return dbInstance;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return { isError: true, ...text(`Error: ${(err as Error).message}`) };
}

server.tool(
  "list_features",
  "List features with their metadata, filterable by status/assignee/tag.",
  {
    workspace: z
      .string()
      .describe("Workspace slug (self-host/local default: 'local')"),
    status: z.string().optional(),
    assignee: z.string().optional(),
  },
  async ({ workspace, status, assignee }) => {
    try {
      const ws = await db().query.workspaces.findFirst({
        where: eq(workspaces.slug, workspace),
      });
      if (!ws)
        return errorResult(new Error(`No workspace with slug "${workspace}"`));
      const rows = await db().query.features.findMany({
        where: and(
          eq(features.workspaceId, ws.id),
          ...(status ? [eq(features.status, status)] : []),
          ...(assignee ? [eq(features.assigneeId, assignee)] : []),
        ),
        with: { index: true },
      });
      // Resolve `blocks` edges so agents can respect sequencing.
      const specById = new Map(rows.map((r) => [r.id, r.specId]));
      const blockLinks = await db()
        .select({
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, ws.id),
            eq(featureLinks.type, "blocks"),
          ),
        );
      const blocks = new Map<string, string[]>();
      const blockedBy = new Map<string, string[]>();
      const push = (m: Map<string, string[]>, key: string, val: string) => {
        const list = m.get(key) ?? [];
        list.push(val);
        m.set(key, list);
      };
      for (const l of blockLinks) {
        const fromSpec = specById.get(l.fromFeatureId);
        const toSpec = specById.get(l.toFeatureId);
        if (fromSpec && toSpec) {
          push(blocks, l.fromFeatureId, toSpec);
          push(blockedBy, l.toFeatureId, fromSpec);
        }
      }
      // Hierarchy roll-up from the same row set.
      const childCount = new Map<string, number>();
      const childDone = new Map<string, number>();
      for (const r of rows) {
        if (!r.parentId) continue;
        childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
        if (r.status === "done")
          childDone.set(r.parentId, (childDone.get(r.parentId) ?? 0) + 1);
      }
      const rolled = rollUpEstimates(
        rows.map((r) => ({
          key: r.id,
          parentKey: r.parentId,
          estimate: r.estimate,
        })),
      );
      return text(
        rows
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((f) => ({
            specId: f.specId,
            title: f.title,
            status: f.status,
            priority: f.priority,
            estimate: f.estimate,
            rolledEstimate: rolled.get(f.id) ?? null,
            tags: f.tags,
            roadmapQuarter: f.roadmapQuarter,
            path: f.index?.path,
            parentSpecId: f.parentId ? (specById.get(f.parentId) ?? null) : null,
            childCount: childCount.get(f.id) ?? 0,
            childDoneCount: childDone.get(f.id) ?? 0,
            blocks: blocks.get(f.id) ?? [],
            blockedBy: blockedBy.get(f.id) ?? [],
          })),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "read_spec",
  "Read a feature's full spec markdown plus its current metadata.",
  { specId: z.string().uuid() },
  async ({ specId }) => {
    try {
      const row = await db().query.features.findFirst({
        where: eq(features.specId, specId),
        with: { index: true },
      });
      if (!row)
        return errorResult(new Error(`No feature with spec id ${specId}`));
      let parentSpecId: string | null = null;
      if (row.parentId) {
        const parent = await db().query.features.findFirst({
          where: eq(features.id, row.parentId),
          columns: { specId: true },
        });
        parentSpecId = parent?.specId ?? null;
      }
      const children = await db()
        .select({ specId: features.specId, title: features.title, status: features.status })
        .from(features)
        .where(eq(features.parentId, row.id));
      // Roll the estimate up over this feature's subtree.
      const estimateRows = await db()
        .select({
          id: features.id,
          parentId: features.parentId,
          estimate: features.estimate,
        })
        .from(features)
        .where(eq(features.workspaceId, row.workspaceId));
      const rolled = rollUpEstimates(
        estimateRows.map((r) => ({
          key: r.id,
          parentKey: r.parentId,
          estimate: r.estimate,
        })),
      );
      return text({
        specId: row.specId,
        title: row.title,
        status: row.status,
        priority: row.priority,
        estimate: row.estimate,
        rolledEstimate: rolled.get(row.id) ?? null,
        tags: row.tags,
        roadmapQuarter: row.roadmapQuarter,
        path: row.index?.path,
        parentSpecId,
        children,
        content: row.index?.content ?? "",
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "get_relations",
  "List a feature's typed relations (blocks / blocked-by / relates-to / duplicates).",
  { specId: z.string().uuid() },
  async ({ specId }) => {
    try {
      const row = await db().query.features.findFirst({
        where: eq(features.specId, specId),
      });
      if (!row)
        return errorResult(new Error(`No feature with spec id ${specId}`));
      const links = await db()
        .select({
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
          type: featureLinks.type,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, row.workspaceId),
            or(
              eq(featureLinks.fromFeatureId, row.id),
              eq(featureLinks.toFeatureId, row.id),
            ),
          ),
        );
      const otherIds = links.map((l) =>
        l.fromFeatureId === row.id ? l.toFeatureId : l.fromFeatureId,
      );
      const others = otherIds.length
        ? await db()
            .select({ id: features.id, specId: features.specId, title: features.title })
            .from(features)
            .where(inArray(features.id, otherIds))
        : [];
      const byId = new Map(others.map((o) => [o.id, o]));
      const relations = links
        .map((l) => {
          const outgoing = l.fromFeatureId === row.id;
          const other = byId.get(outgoing ? l.toFeatureId : l.fromFeatureId);
          if (!other) return null;
          const direction =
            l.type === "blocks"
              ? outgoing
                ? "blocks"
                : "blocked_by"
              : l.type === "duplicates"
                ? outgoing
                  ? "duplicates"
                  : "duplicated_by"
                : "relates_to";
          return { direction, specId: other.specId, title: other.title };
        })
        .filter(Boolean);
      return text({ specId: row.specId, title: row.title, relations });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "update_status",
  "Move a feature to a new status (validated against the workflow).",
  { specId: z.string().uuid(), status: z.string() },
  async ({ specId, status }) => {
    try {
      const row = await db().query.features.findFirst({
        where: eq(features.specId, specId),
      });
      if (!row)
        return errorResult(new Error(`No feature with spec id ${specId}`));
      if (!canTransition(row.status, status)) {
        return errorResult(
          new Error(`Illegal transition: ${row.status} -> ${status}`),
        );
      }
      await db()
        .update(features)
        .set({ status, updatedAt: new Date() })
        .where(eq(features.id, row.id));
      return text(`${row.title}: ${row.status} -> ${status}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("specboard-mcp failed to start:", err);
  process.exit(1);
});
