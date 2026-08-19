#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import {
  DEFAULT_STATUSES,
  DEFAULT_TRANSITION_MODE,
  canReadProduct,
  canWriteProduct,
  canTransition,
  configPinsTransitions,
  defaultWorkflow,
  descendantGroupIds,
  isForwardTransition,
  isTransitionMode,
  resolveWorkflow,
  safeParseRepoConfig,
  transitionErrorMessage,
  workflowFromStages,
  type ProductAccess,
  type StatusWorkflow,
  type TransitionMode,
} from "@specboards/core";
import {
  createDb,
  featureGateCompletions,
  featureLinks,
  features,
  members,
  productGroups,
  productMembers,
  productSettings,
  products,
  repositories,
  workspaces,
  workspaceStageGates,
  workspaceStatuses,
  type Database,
} from "@specboards/db";

/**
 * Specboards MCP server. Gives coding agents a status-aware view of specs:
 * they see not just the markdown (canonical in git) but the metadata
 * (status, assignee, tags) layered on top from the DB.
 *
 * Requires DATABASE_URL (the same Postgres the web app uses).
 */

/**
 * An error whose message was written for whoever made the call: a setup step
 * they have to take, a name that does not resolve, an argument out of scope.
 *
 * The same split the hosted `/api/mcp` makes, for the same reason. Everything
 * else reaching `errorResult` came from a library and quotes internals: a
 * drizzle `DrizzleQueryError`'s message is the whole failing statement plus
 * every bound parameter, so returning it verbatim handed the connected agent
 * the schema. This server is a local subprocess rather than a shared endpoint,
 * which makes that far less serious than it was on the hosted path, but it is
 * the same mistake and it costs nothing to not make it.
 *
 * Its own class rather than a shared one: this app deliberately does not depend
 * on the web app, and a marker class is a smaller thing to duplicate than a
 * dependency is to add.
 */
class McpUserError extends Error {}

const server = new McpServer({ name: "specboard", version: "0.1.0" });

let dbInstance: Database | undefined;
function db(): Database {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new McpUserError(
        "DATABASE_URL is not set. Point it at the Specboards Postgres (e.g. postgres://postgres:postgres@localhost:5432/specboard) and seed it with `pnpm --filter @specboards/db seed`.",
      );
    }
    dbInstance = createDb(url);
  }
  return dbInstance;
}

interface McpScope {
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
  access: ProductAccess;
}

let scopeInstance: McpScope | undefined;

async function mcpScope(): Promise<McpScope> {
  if (scopeInstance) return scopeInstance;
  const userId = process.env.SPECBOARDS_MCP_USER_ID;
  if (!userId) {
    throw new McpUserError(
      "SPECBOARDS_MCP_USER_ID is required. Use a real Specboards user id so MCP access is scoped to that user's workspace and product roles.",
    );
  }
  const requestedWorkspace = process.env.SPECBOARDS_MCP_WORKSPACE?.trim();
  const memberships = await db()
    .select({
      workspaceId: members.workspaceId,
      role: members.role,
      slug: workspaces.slug,
    })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(eq(members.userId, userId));
  const membership = requestedWorkspace
    ? memberships.find(
        (row) =>
          row.workspaceId === requestedWorkspace ||
          row.slug === requestedWorkspace,
      )
    : memberships.length === 1
      ? memberships[0]
      : undefined;
  if (!membership) {
    throw new McpUserError(
      requestedWorkspace
        ? `User ${userId} is not a member of workspace ${requestedWorkspace}.`
        : "SPECBOARDS_MCP_WORKSPACE is required when the MCP user belongs to zero or multiple workspaces.",
    );
  }
  const grants = await db()
    .select({ productId: productMembers.productId, role: productMembers.role })
    .from(productMembers)
    .where(
      and(
        eq(productMembers.workspaceId, membership.workspaceId),
        eq(productMembers.userId, userId),
      ),
    );
  scopeInstance = {
    userId,
    workspaceId: membership.workspaceId,
    workspaceSlug: membership.slug,
    access: {
      isOrgAdmin: membership.role === "owner",
      roles: new Map(
        grants.map((grant) => [grant.productId, grant.role] as const),
      ),
    },
  };
  return scopeInstance;
}

async function productVisibility(
  workspaceId: string,
): Promise<Map<string, { id: string; visibility: "org" | "private" }>> {
  const rows = await db()
    .select({ id: products.id, visibility: products.visibility })
    .from(products)
    .where(eq(products.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.id, row]));
}

function canReadProductId(
  access: ProductAccess,
  productById: ReadonlyMap<
    string,
    { id: string; visibility: "org" | "private" }
  >,
  productId: string | null,
): boolean {
  if (productId === null) return true;
  const product = productById.get(productId);
  return product ? canReadProduct(access, product) : false;
}

function canWriteProductId(
  access: ProductAccess,
  productId: string | null,
): boolean {
  if (productId === null) return access.isOrgAdmin;
  return canWriteProduct(access, productId);
}

function assertWorkspaceArg(scope: McpScope, workspace: string): void {
  if (workspace !== scope.workspaceSlug && workspace !== scope.workspaceId) {
    throw new McpUserError(`MCP is scoped to workspace "${scope.workspaceSlug}".`);
  }
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
  if (err instanceof McpUserError) {
    return { isError: true, ...text(`Error: ${err.message}`) };
  }
  // Withheld, and logged to stderr instead: stdout is the JSON-RPC transport,
  // so anything written there would corrupt the stream.
  console.error("[specboards-mcp] tool failed:", err);
  return {
    isError: true,
    ...text(
      "Error: the tool failed for an internal reason, which has been written " +
        "to this server's stderr. Changing the arguments will not fix it.",
    ),
  };
}

server.tool(
  "list_features",
  "List features with their metadata, filterable by status/assignee/product/group.",
  {
    workspace: z
      .string()
      .describe("Workspace slug (self-host/local default: 'local')"),
    status: z.string().optional(),
    assignee: z.string().optional(),
    product: z
      .string()
      .optional()
      .describe(
        "Product key (sibling backlog) to filter to; see list_products",
      ),
    group: z
      .string()
      .optional()
      .describe(
        "Product group key to filter to (includes nested groups' products); see list_product_groups",
      ),
  },
  async ({ workspace, status, assignee, product, group }) => {
    try {
      const scope = await mcpScope();
      assertWorkspaceArg(scope, workspace);
      const productById = await productVisibility(scope.workspaceId);
      // Resolve products for output labels + the optional product filter.
      const prodsRaw = await db()
        .select({
          id: products.id,
          key: products.key,
          groupId: products.groupId,
        })
        .from(products)
        .where(eq(products.workspaceId, scope.workspaceId));
      const prods = prodsRaw.filter((p) =>
        canReadProductId(scope.access, productById, p.id),
      );
      const prodKeyById = new Map(prods.map((p) => [p.id, p.key]));
      let productId: string | undefined;
      if (product) {
        const match = prods.find((p) => p.key === product);
        if (!match)
          return errorResult(new McpUserError(`No product with key "${product}"`));
        productId = match.id;
      }
      let groupProductIds: Set<string> | undefined;
      if (group) {
        const groupRows = await db()
          .select({
            id: productGroups.id,
            key: productGroups.key,
            parentId: productGroups.parentId,
          })
          .from(productGroups)
          .where(eq(productGroups.workspaceId, scope.workspaceId));
        const match = groupRows.find((g) => g.key === group);
        if (!match)
          return errorResult(new McpUserError(`No product group with key "${group}"`));
        const subtree = descendantGroupIds(groupRows, match.id);
        groupProductIds = new Set(
          prods
            .filter((p) => p.groupId && subtree.has(p.groupId))
            .map((p) => p.id),
        );
      }
      const rows = await db().query.features.findMany({
        where: and(
          eq(features.workspaceId, scope.workspaceId),
          ...(status ? [eq(features.status, status)] : []),
          ...(assignee ? [eq(features.assigneeId, assignee)] : []),
          ...(productId ? [eq(features.productId, productId)] : []),
        ),
        with: { index: true },
      });
      const visibleRows = rows.filter(
        (row) =>
          canReadProductId(scope.access, productById, row.productId) &&
          (!groupProductIds ||
            (row.productId !== null && groupProductIds.has(row.productId))),
      );
      // Resolve `blocks` edges so agents can respect sequencing.
      const visibleIds = new Set(visibleRows.map((r) => r.id));
      const specById = new Map(visibleRows.map((r) => [r.id, r.specId]));
      const blockLinks = await db()
        .select({
          fromFeatureId: featureLinks.fromFeatureId,
          toFeatureId: featureLinks.toFeatureId,
        })
        .from(featureLinks)
        .where(
          and(
            eq(featureLinks.workspaceId, scope.workspaceId),
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
        if (!visibleIds.has(l.fromFeatureId) || !visibleIds.has(l.toFeatureId))
          continue;
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
      for (const r of visibleRows) {
        if (!r.parentId || !visibleIds.has(r.parentId)) continue;
        childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
        if (r.status === "done")
          childDone.set(r.parentId, (childDone.get(r.parentId) ?? 0) + 1);
      }
      return text(
        visibleRows
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((f) => ({
            specId: f.specId,
            title: f.title,
            level: f.level,
            product: f.productId
              ? (prodKeyById.get(f.productId) ?? null)
              : null,
            status: f.status,
            tags: f.tags,
            path: f.index?.path,
            parentSpecId: f.parentId
              ? (specById.get(f.parentId) ?? null)
              : null,
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
      const scope = await mcpScope();
      const productById = await productVisibility(scope.workspaceId);
      const row = await db().query.features.findFirst({
        where: and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
        with: { index: true },
      });
      if (!row)
        return errorResult(new McpUserError(`No feature with spec id ${specId}`));
      if (!canReadProductId(scope.access, productById, row.productId))
        return errorResult(new McpUserError(`No feature with spec id ${specId}`));
      let parentSpecId: string | null = null;
      if (row.parentId) {
        const parent = await db().query.features.findFirst({
          where: and(
            eq(features.id, row.parentId),
            eq(features.workspaceId, scope.workspaceId),
          ),
          columns: { specId: true, productId: true },
        });
        if (
          parent &&
          canReadProductId(scope.access, productById, parent.productId)
        )
          parentSpecId = parent.specId;
      }
      const children = (
        await db()
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
              eq(features.workspaceId, scope.workspaceId),
            ),
          )
      )
        .filter((child) =>
          canReadProductId(scope.access, productById, child.productId),
        )
        .map(({ productId: _productId, ...child }) => child);
      let product: string | null = null;
      if (row.productId) {
        const p = await db().query.products.findFirst({
          where: eq(products.id, row.productId),
          columns: { key: true },
        });
        product = p?.key ?? null;
      }
      return text({
        specId: row.specId,
        title: row.title,
        level: row.level,
        product,
        status: row.status,
        tags: row.tags,
        path: row.index?.path,
        parentSpecId,
        children,
        // DB-native items (initiatives/epics) have no spec content.
        content: row.index?.content ?? "",
      });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "list_products",
  "List the products (sibling backlogs) in a workspace; each has its own hierarchy.",
  {
    workspace: z
      .string()
      .describe("Workspace slug (self-host/local default: 'local')"),
  },
  async ({ workspace }) => {
    try {
      const scope = await mcpScope();
      assertWorkspaceArg(scope, workspace);
      const productById = await productVisibility(scope.workspaceId);
      const groupRows = await db()
        .select({ id: productGroups.id, key: productGroups.key })
        .from(productGroups)
        .where(eq(productGroups.workspaceId, scope.workspaceId));
      const groupKeyById = new Map(groupRows.map((g) => [g.id, g.key]));
      const rows = (
        await db()
          .select({
            id: products.id,
            key: products.key,
            name: products.name,
            description: products.description,
            visibility: products.visibility,
            position: products.position,
            groupId: products.groupId,
          })
          .from(products)
          .where(eq(products.workspaceId, scope.workspaceId))
      ).filter((product) =>
        canReadProductId(scope.access, productById, product.id),
      );
      return text(
        rows
          .sort(
            (a, b) => a.position - b.position || a.name.localeCompare(b.name),
          )
          .map((p) => ({
            key: p.key,
            name: p.name,
            description: p.description,
            visibility: p.visibility,
            group: (p.groupId && groupKeyById.get(p.groupId)) || null,
          })),
      );
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "list_product_groups",
  "List the workspace's product groups (management roll-up nodes). Nested groups point at their parent via parentKey; productKeys are the caller-readable products directly in each group. Use a key with list_features(group).",
  {
    workspace: z
      .string()
      .describe("Workspace slug (self-host/local default: 'local')"),
  },
  async ({ workspace }) => {
    try {
      const scope = await mcpScope();
      assertWorkspaceArg(scope, workspace);
      const productById = await productVisibility(scope.workspaceId);
      const [groupRows, productRows] = await Promise.all([
        db()
          .select({
            id: productGroups.id,
            key: productGroups.key,
            name: productGroups.name,
            description: productGroups.description,
            parentId: productGroups.parentId,
            position: productGroups.position,
          })
          .from(productGroups)
          .where(eq(productGroups.workspaceId, scope.workspaceId))
          .orderBy(asc(productGroups.position), asc(productGroups.name)),
        db()
          .select({ id: products.id, key: products.key, groupId: products.groupId })
          .from(products)
          .where(eq(products.workspaceId, scope.workspaceId)),
      ]);
      const readable = productRows.filter((p) =>
        canReadProductId(scope.access, productById, p.id),
      );
      const keyById = new Map(groupRows.map((g) => [g.id, g.key]));
      return text(
        groupRows.map((g) => ({
          key: g.key,
          name: g.name,
          description: g.description,
          parentKey: (g.parentId && keyById.get(g.parentId)) || null,
          productKeys: readable
            .filter((p) => p.groupId === g.id)
            .map((p) => p.key),
        })),
      );
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
      const scope = await mcpScope();
      const productById = await productVisibility(scope.workspaceId);
      const row = await db().query.features.findFirst({
        where: and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      });
      if (!row)
        return errorResult(new McpUserError(`No feature with spec id ${specId}`));
      if (!canReadProductId(scope.access, productById, row.productId))
        return errorResult(new McpUserError(`No feature with spec id ${specId}`));
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
            .select({
              id: features.id,
              specId: features.specId,
              title: features.title,
              productId: features.productId,
            })
            .from(features)
            .where(
              and(
                eq(features.workspaceId, scope.workspaceId),
                inArray(features.id, otherIds),
              ),
            )
        : [];
      const byId = new Map(
        others
          .filter((other) =>
            canReadProductId(scope.access, productById, other.productId),
          )
          .map((o) => [o.id, o]),
      );
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
      const scope = await mcpScope();
      const row = await db().query.features.findFirst({
        where: and(
          eq(features.specId, specId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      });
      if (!row)
        return errorResult(new McpUserError(`No feature with spec id ${specId}`));
      if (!canWriteProductId(scope.access, row.productId)) {
        return errorResult(
          new McpUserError("Your MCP user cannot edit this feature's product."),
        );
      }
      // Validate against the item's product's (possibly custom) workflow.
      const workflow = await resolveWorkspaceWorkflow(
        scope.workspaceId,
        row.productId,
      );
      if (!canTransition(row.status, status, workflow)) {
        return errorResult(
          new McpUserError(transitionErrorMessage(row.status, status, workflow)),
        );
      }
      // Exit-criteria stage gates block forward moves (mirrors the web app).
      if (isForwardTransition(row.status, status, workflow)) {
        // Every stage advanced past (source up to, not including, the target).
        const fromIndex = workflow.statuses.indexOf(row.status);
        const toIndex = workflow.statuses.indexOf(status);
        const passed = workflow.statuses.slice(fromIndex, toIndex);
        const open = await openGates(scope.workspaceId, row.id, passed);
        if (open.length > 0) {
          return errorResult(
            new McpUserError(
              `Blocked by stage gates. Complete first: ${open
                .map((g) => `"${g}"`)
                .join(", ")}.`,
            ),
          );
        }
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

/**
 * The status workflow for a product. Precedence mirrors the web app:
 * admin-defined stages (workspace_statuses) first, then the repo config's
 * statuses, then the built-in default. The transitions between those stages
 * come from the transition mode (strict = a pipeline, flexible = any stage to
 * any other), except where a repo config pins `transitions` itself.
 *
 * `productId` is the product whose rules apply, which for an item is its own:
 * this server and the web app must agree about the same item, and the web app
 * validates against the item's product.
 */
async function resolveWorkspaceWorkflow(
  workspaceId: string,
  productId: string | null,
): Promise<StatusWorkflow> {
  const [repo] = await db()
    .select({ config: repositories.config })
    .from(repositories)
    .where(eq(repositories.workspaceId, workspaceId));
  const config = safeParseRepoConfig(repo?.config);
  if (configPinsTransitions(config)) return resolveWorkflow(config);

  const mode = await resolveTransitionMode(workspaceId, productId);
  const stages = await db()
    .select({ key: workspaceStatuses.key, label: workspaceStatuses.label })
    .from(workspaceStatuses)
    .where(eq(workspaceStatuses.workspaceId, workspaceId))
    .orderBy(asc(workspaceStatuses.position));
  const custom = workflowFromStages(stages, mode);
  if (custom) return custom;

  const vocabulary =
    config?.statuses && config.statuses.length >= 2
      ? config.statuses.filter((s) => s !== "archived")
      : DEFAULT_STATUSES.filter((s) => s !== "archived");
  return (
    workflowFromStages(
      vocabulary.map((key) => ({ key, label: key })),
      mode,
    ) ?? defaultWorkflow
  );
}

/**
 * A product's transition mode: its own override if it set one, otherwise the
 * workspace default row, otherwise the built-in default. An unreadable stored
 * value reads as strict, the safer of the two.
 *
 * Both candidate rows come back in one query because a product row that exists
 * with a null mode is an explicit "inherit", not an override.
 */
async function resolveTransitionMode(
  workspaceId: string,
  productId: string | null,
): Promise<TransitionMode> {
  const rows = await db()
    .select({
      productId: productSettings.productId,
      mode: productSettings.transitionMode,
    })
    .from(productSettings)
    .where(
      and(
        eq(productSettings.workspaceId, workspaceId),
        productId
          ? or(
              eq(productSettings.productId, productId),
              isNull(productSettings.productId),
            )
          : isNull(productSettings.productId),
      ),
    );
  const own = productId
    ? rows.find((r) => r.productId === productId)?.mode
    : null;
  const fallback = rows.find((r) => r.productId === null)?.mode;
  const effective = own ?? fallback;
  if (effective === null || effective === undefined) {
    return DEFAULT_TRANSITION_MODE;
  }
  return isTransitionMode(effective) ? effective : "strict";
}

/**
 * Labels of the gates on `stageKeys` not yet completed for feature `featureId`.
 * Empty when those stages have no gates or they're all checked off. Mirrors the
 * web app's exit-criteria enforcement so agents can't advance an item past a
 * checklist, including by jumping over an intermediate stage.
 */
async function openGates(
  workspaceId: string,
  featureId: string,
  stageKeys: string[],
): Promise<string[]> {
  if (stageKeys.length === 0) return [];
  const gates = await db()
    .select({ id: workspaceStageGates.id, label: workspaceStageGates.label })
    .from(workspaceStageGates)
    .where(
      and(
        eq(workspaceStageGates.workspaceId, workspaceId),
        inArray(workspaceStageGates.stageKey, stageKeys),
      ),
    );
  if (gates.length === 0) return [];
  const completed = await db()
    .select({ gateId: featureGateCompletions.gateId })
    .from(featureGateCompletions)
    .where(eq(featureGateCompletions.featureId, featureId));
  const done = new Set(completed.map((c) => c.gateId));
  return gates.filter((g) => !done.has(g.id)).map((g) => g.label);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("specboard-mcp failed to start:", err);
  process.exit(1);
});
