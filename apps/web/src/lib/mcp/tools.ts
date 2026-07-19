import { descendantGroupIds } from "@specboard/core";
import { eq, users, workspaces } from "@specboard/db";

import { getDb } from "@/lib/db";
import { resolveWorkflowFor } from "@/lib/repo-config";
import {
  createRelease,
  createWorkItem,
  deleteWorkItem,
  listReleases,
  parseCreateFeatureInput,
  parseFeaturePatch,
  parseReleaseInput,
  parseReleasePatch,
  patchFeature,
  updateRelease,
} from "@/lib/features-service";
import { createSpec, updateSpecContent } from "@/lib/spec-content";
import { getStore, type WorkspaceScope } from "@/lib/store";
import { type MemberRole } from "@/lib/workspace";

/**
 * The MCP tools Specboard exposes to coding agents. Each tool is a thin adapter
 * over the same service layer the REST API uses (`features-service`, the
 * `store`), so authorization, the status workflow, stage gates, and webhook
 * emission all behave identically to the web app - no logic is duplicated here.
 */

/** Per-call tenant context, resolved once per request from the API key. */
export interface McpContext {
  /** Tenant scope passed to the store; `undefined` in local file mode. */
  scope: WorkspaceScope | undefined;
  /** The caller's workspace role, or null in local file mode. */
  role: MemberRole | null;
  /** True when auth is disabled (self-host local file mode): everything allowed. */
  isLocal: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (advertised via tools/list). */
  inputSchema: Record<string, unknown>;
  /** Marks a mutating tool. Any member may attempt it; per-product write
   * (owner, or an admin/contributor grant) is enforced by the store on run. */
  write: boolean;
  run: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * Git-backed tools need a real workspace + database (they commit to GitHub).
 * Resolve both, or fail with a clear message in local file mode.
 */
function requireDbScope(ctx: McpContext): {
  db: NonNullable<ReturnType<typeof getDb>>;
  scope: WorkspaceScope;
} {
  const db = getDb();
  if (!db || !ctx.scope) {
    throw new Error(
      "Editing spec content needs a database-backed deployment with a " +
        "connected GitHub repository; it is unavailable in local file mode.",
    );
  }
  return { db, scope: ctx.scope };
}

/** Shared JSON Schema fragment for a spec id argument. */
const specIdSchema = {
  type: "string",
  description: "The item's stable spec id (a UUID; see list_items).",
} as const;

export const TOOLS: McpTool[] = [
  {
    name: "whoami",
    description:
      "Identify the caller: the user, their workspace, their org role " +
      "(`owner` administers everything; `member` is read-only at the org), the " +
      "workspace's hierarchy levels (top to leaf), and their per-product access " +
      "(`products[].role`: admin/contributor can write that product, viewer is " +
      "read-only). Call this first to learn which products you can write and " +
      "which level keys are valid for create_item.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const store = await getStore();
      const [levels, products] = await Promise.all([
        store.listLevels(ctx.scope),
        store.listProducts(ctx.scope),
      ]);
      const levelsOut = levels.map((l) => ({
        key: l.key,
        label: l.label,
        isLeaf: l.isLeaf,
      }));
      const isOwner = ctx.isLocal || ctx.role === "owner";
      // Effective product role for the agent: owner (and local mode) is admin
      // everywhere; otherwise the explicit per-product grant (or viewer for an
      // org-visibility product the member can read but not edit).
      const productsOut = products.map((p) => ({
        key: p.key,
        name: p.name,
        role: isOwner ? "admin" : (p.viewerRole ?? "viewer"),
      }));
      if (ctx.isLocal || !ctx.scope) {
        return {
          mode: "local",
          user: null,
          workspace: null,
          role: null,
          isOwner: true,
          products: productsOut,
          levels: levelsOut,
        };
      }
      const db = getDb();
      let user: { id: string; name: string; email: string } | null = null;
      let workspace: { id: string; name: string; slug: string } | null = null;
      if (db) {
        const [u] = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, ctx.scope.userId))
          .limit(1);
        const [w] = await db
          .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
          .from(workspaces)
          .where(eq(workspaces.id, ctx.scope.workspaceId))
          .limit(1);
        user = u ?? null;
        workspace = w ?? null;
      }
      return {
        mode: "workspace",
        user,
        workspace,
        role: ctx.role,
        isOwner,
        products: productsOut,
        levels: levelsOut,
      };
    },
  },
  {
    name: "list_statuses",
    description:
      "List the workspace's status workflow: the ordered stage keys (use these " +
      "exact keys with update_item), each stage's display label, and the moves " +
      "allowed out of it. The default workflow permits only single-step moves " +
      "(e.g. `backlog` reaches only `defining` or `archived`), so to advance " +
      "several stages call update_item once per step. Call this before changing " +
      "an item's status so you never have to guess a stage key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const workflow = await resolveWorkflowFor(ctx.scope ?? null);
      const titleCase = (key: string) =>
        key
          .split(/[_\s-]+/)
          .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
          .join(" ");
      return {
        statuses: workflow.statuses.map((key) => ({
          key,
          label: workflow.labels?.[key] ?? titleCase(key),
          allowedTransitions: workflow.transitions[key] ?? [],
        })),
      };
    },
  },
  {
    name: "list_products",
    description:
      "List the products (sibling backlogs) the caller can see. Each product " +
      "has its own hierarchy of items. Use a product's `key` to filter " +
      "list_items, or its `id` for create_item. `group` is the key of the " +
      "product group the product belongs to (null when ungrouped).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const store = await getStore();
      const [products, groups] = await Promise.all([
        store.listProducts(ctx.scope),
        store.listProductGroups(ctx.scope),
      ]);
      const groupKeyById = new Map(groups.map((g) => [g.id, g.key]));
      return products.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        group: (p.groupId && groupKeyById.get(p.groupId)) || null,
        itemCount: p.itemCount,
      }));
    },
  },
  {
    name: "list_product_groups",
    description:
      "List the workspace's product groups: management-level nodes that " +
      "collect products (and other groups) for roll-up. `productKeys` are the " +
      "caller-readable products directly in the group; nested groups point at " +
      "their parent via `parentKey`. Use a group's key with list_items " +
      "(`group`) or group_summary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const store = await getStore();
      const [groups, products] = await Promise.all([
        store.listProductGroups(ctx.scope),
        store.listProducts(ctx.scope),
      ]);
      const keyById = new Map(groups.map((g) => [g.id, g.key]));
      return groups.map((g) => ({
        key: g.key,
        name: g.name,
        description: g.description,
        parentKey: (g.parentId && keyById.get(g.parentId)) || null,
        productKeys: products.filter((p) => p.groupId === g.id).map((p) => p.key),
      }));
    },
  },
  {
    name: "group_summary",
    description:
      "A product group's management roll-up: per-product item counts, status " +
      "breakdowns, and release progress over the readable products in the " +
      "group's subtree (nested groups included), plus its direct subgroups. " +
      "Aggregates only cover products the caller can read.",
    inputSchema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          description: "The group's key (see list_product_groups).",
        },
      },
      required: ["group"],
      additionalProperties: false,
    },
    write: false,
    run: async (args, ctx) => {
      const store = await getStore();
      const [groups, products, releases] = await Promise.all([
        store.listProductGroups(ctx.scope),
        store.listProducts(ctx.scope),
        store.listReleases(ctx.scope),
      ]);
      const group = groups.find((g) => g.key === args.group);
      if (!group) throw new Error(`No product group with key "${args.group}".`);
      const summary = await store.getGroupSummary(group.id, ctx.scope);
      const productKeyById = new Map(products.map((p) => [p.id, p.key]));
      const releaseNameById = new Map(releases.map((r) => [r.id, r.name]));
      return {
        group: { key: summary.group.key, name: summary.group.name },
        subgroups: summary.subgroups.map((g) => ({ key: g.key, name: g.name })),
        products: summary.products.map((s) => ({
          product: productKeyById.get(s.productId) ?? s.productId,
          itemCount: s.itemCount,
          statusCounts: s.statusCounts,
          releases: s.releases.map((r) => ({
            release: releaseNameById.get(r.releaseId) ?? r.releaseId,
            total: r.total,
            done: r.done,
          })),
        })),
      };
    },
  },
  {
    name: "list_items",
    description:
      "List work items (specs and DB-native cards) in the caller's workspace " +
      "with their metadata. Optionally filter by status, product key, product " +
      "group key (includes nested groups' products), or assignee user id. " +
      "Returns lean rows; call read_item for full content.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter to one status key." },
        product: {
          type: "string",
          description: "Filter to one product by its key (see list_products).",
        },
        group: {
          type: "string",
          description:
            "Filter to a product group's subtree by its key (see " +
            "list_product_groups).",
        },
        assignee: {
          type: "string",
          description: "Filter to items assigned to this user id.",
        },
      },
      additionalProperties: false,
    },
    write: false,
    run: async (args, ctx) => {
      const store = await getStore();
      const [features, products] = await Promise.all([
        store.listFeatures(ctx.scope),
        store.listProducts(ctx.scope),
      ]);
      const keyById = new Map(products.map((p) => [p.id, p.key]));
      let productId: string | undefined;
      if (typeof args.product === "string" && args.product) {
        const match = products.find((p) => p.key === args.product);
        if (!match) throw new Error(`No product with key "${args.product}".`);
        productId = match.id;
      }
      let groupProductIds: Set<string> | undefined;
      if (typeof args.group === "string" && args.group) {
        const groups = await store.listProductGroups(ctx.scope);
        const match = groups.find((g) => g.key === args.group);
        if (!match) throw new Error(`No product group with key "${args.group}".`);
        const subtree = descendantGroupIds(groups, match.id);
        groupProductIds = new Set(
          products
            .filter((p) => p.groupId && subtree.has(p.groupId))
            .map((p) => p.id),
        );
      }
      const status = typeof args.status === "string" ? args.status : undefined;
      const assignee =
        typeof args.assignee === "string" ? args.assignee : undefined;
      return features
        .filter(
          (f) =>
            (!status || f.status === status) &&
            (!assignee || f.assigneeId === assignee) &&
            (!productId || f.productId === productId) &&
            (!groupProductIds ||
              (f.productId !== null && groupProductIds.has(f.productId))),
        )
        .map((f) => ({
          specId: f.specId,
          title: f.title,
          level: f.level,
          isDbNative: f.isDbNative,
          status: f.status,
          tags: f.tags,
          product: f.productId ? (keyById.get(f.productId) ?? null) : null,
          assigneeId: f.assigneeId,
          releaseId: f.releaseId,
          parentSpecId: f.parentSpecId,
          childCount: f.childCount,
          childDoneCount: f.childDoneCount,
          blocksCount: f.blocksCount,
          blockedByCount: f.blockedByCount,
          path: f.path,
        }));
    },
  },
  {
    name: "read_item",
    description:
      "Read one item in full: its metadata, Markdown content (spec body for " +
      "spec-backed items, or the card's details for DB-native items), typed " +
      "relations, parent, and children. This is the 'review' view.",
    inputSchema: {
      type: "object",
      properties: { specId: specIdSchema },
      required: ["specId"],
      additionalProperties: false,
    },
    write: false,
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      const f = await store.getFeature(specId, ctx.scope);
      if (!f) throw new Error(`No item with spec id ${specId}.`);
      // Advertise the moves update_item will accept from here, so agents step
      // the workflow instead of guessing stage keys (see list_statuses).
      const workflow = await resolveWorkflowFor(ctx.scope ?? null);
      return {
        specId: f.specId,
        title: f.title,
        level: f.level,
        isDbNative: f.isDbNative,
        status: f.status,
        allowedTransitions: workflow.transitions[f.status] ?? [],
        tags: f.tags,
        releaseId: f.releaseId,
        assigneeId: f.assigneeId,
        assigneeName: f.assigneeName,
        customFields: f.customFields,
        path: f.path,
        parentSpecId: f.parentSpecId,
        parentTitle: f.parentTitle,
        children: f.children,
        relations: f.relations,
        content: f.content,
      };
    },
  },
  {
    name: "get_relations",
    description:
      "List one item's typed relations from its own perspective " +
      "(blocks / blocked_by / relates_to / duplicates / duplicated_by).",
    inputSchema: {
      type: "object",
      properties: { specId: specIdSchema },
      required: ["specId"],
      additionalProperties: false,
    },
    write: false,
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      const f = await store.getFeature(specId, ctx.scope);
      if (!f) throw new Error(`No item with spec id ${specId}.`);
      return { specId: f.specId, title: f.title, relations: f.relations };
    },
  },
  {
    name: "update_item",
    description:
      "Update an item's metadata and (for DB-native cards) its content. " +
      "Set any of: status, tags, releaseId, assigneeId, customFields, " +
      "parentSpecId, and - for DB-native cards only - title and details " +
      "(Markdown body). Status changes are validated against the workspace " +
      "workflow and its stage gates. A spec-backed item's title and body come " +
      "from git and cannot be patched here (Phase 2). Use this to roll a " +
      "summary of child specs up into a parent card's details.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        status: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        releaseId: { type: ["string", "null"] },
        assigneeId: { type: ["string", "null"] },
        parentSpecId: { type: ["string", "null"] },
        title: {
          type: "string",
          description: "DB-native cards only; spec titles are edited in git.",
        },
        details: {
          type: ["string", "null"],
          description: "DB-native cards only: the Markdown body.",
        },
        customFields: {
          type: "object",
          description: "Map of custom property key to value.",
        },
      },
      required: ["specId"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      // parseFeaturePatch reads only known keys; specId is ignored by it.
      const patch = parseFeaturePatch(args);
      const updated = await patchFeature(specId, patch, ctx.scope);
      return {
        specId: updated.specId,
        title: updated.title,
        status: updated.status,
        tags: updated.tags,
        isDbNative: updated.isDbNative,
      };
    },
  },
  {
    name: "delete_item",
    description:
      "Delete a DB-native work item (an initiative/epic/feature card created " +
      "with create_item). Its children are re-parented to the root (not " +
      "deleted) and its relations are cleared automatically. Spec-backed items " +
      "cannot be deleted here - remove their specs/<slug>/spec.md in git " +
      "instead. This is irreversible, so confirm the specId with read_item " +
      "first.",
    inputSchema: {
      type: "object",
      properties: { specId: specIdSchema },
      required: ["specId"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      // Read first so we can echo back what was removed (and give a clear
      // error before attempting the delete if the id is unknown).
      const existing = await store.getFeature(specId, ctx.scope);
      if (!existing) throw new Error(`No item with spec id ${specId}.`);
      await deleteWorkItem(specId, ctx.scope);
      return { specId, title: existing.title, deleted: true };
    },
  },
  {
    name: "create_item",
    description:
      "Create a DB-native work item (a non-leaf card, e.g. an initiative or " +
      "epic). Leaf specs come from git, not this tool. `level` must be a " +
      "non-leaf level key (see whoami). Optionally set product (key), " +
      "parentSpecId, status, assigneeId, tags, and details (Markdown body).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        level: {
          type: "string",
          description: "A non-leaf level key from whoami (e.g. 'epic').",
        },
        product: {
          type: "string",
          description: "Owning product by key; defaults to the workspace default.",
        },
        parentSpecId: { type: ["string", "null"] },
        status: { type: "string" },
        assigneeId: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        details: { type: ["string", "null"] },
      },
      required: ["title", "level"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      const store = await getStore();
      const raw: Record<string, unknown> = { ...args };
      // Agents pass a product key; the service takes a product id.
      if (typeof raw.product === "string" && raw.product && !("productId" in raw)) {
        const products = await store.listProducts(ctx.scope);
        const match = products.find((p) => p.key === raw.product);
        if (!match) throw new Error(`No product with key "${raw.product}".`);
        raw.productId = match.id;
      }
      delete raw.product;
      const input = parseCreateFeatureInput(raw);
      const created = await createWorkItem(input, ctx.scope);
      return {
        specId: created.specId,
        title: created.title,
        level: created.level,
        status: created.status,
        parentSpecId: created.parentSpecId,
      };
    },
  },
  {
    name: "update_spec_content",
    description:
      "Replace a spec-backed item's Markdown body and commit it to the " +
      "connected GitHub repo (git is canonical; the board re-syncs). Pass the " +
      "full new body as `content` - the same shape read_item returns, without " +
      "frontmatter; the spec's frontmatter and stable id are preserved " +
      "automatically. Only works on spec-backed items; use update_item for " +
      "DB-native cards. This is how an agent edits an actual spec.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        content: {
          type: "string",
          description: "The full new Markdown body (no frontmatter).",
        },
        message: {
          type: "string",
          description: "Optional git commit message.",
        },
      },
      required: ["specId", "content"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      const { db, scope } = requireDbScope(ctx);
      const specId = requireString(args, "specId");
      const content = requireString(args, "content");
      const message =
        typeof args.message === "string" ? args.message : undefined;
      return updateSpecContent(db, scope, specId, content, { message });
    },
  },
  {
    name: "create_spec",
    description:
      "Create a new spec-backed item: commit a new specs/<slug>/spec.md to the " +
      "connected repo (a fresh id is assigned) and sync it onto the board. Use " +
      "this to break a card down into concrete specs - create each spec here, " +
      "then call update_item with parentSpecId to nest it under the card being " +
      "broken down. Optionally target a repo by id (defaults to the workspace " +
      "spec repo).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: {
          type: "string",
          description: "Markdown body (no frontmatter). Defaults to a stub.",
        },
        repoId: {
          type: "string",
          description: "Target repository id; defaults to the spec repo.",
        },
        message: {
          type: "string",
          description: "Optional git commit message.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      const { db, scope } = requireDbScope(ctx);
      const title = requireString(args, "title");
      return createSpec(db, scope, {
        title,
        body: typeof args.body === "string" ? args.body : undefined,
        repoId: typeof args.repoId === "string" ? args.repoId : undefined,
        message: typeof args.message === "string" ? args.message : undefined,
      });
    },
  },
  {
    name: "list_releases",
    description:
      "List the workspace's releases (ship vehicles / versions) with their " +
      "id, name, `productId` (the product the release belongs to, or null for " +
      "a workspace-wide portfolio release), status " +
      "(planned/in_progress/shipped), start/target dates, notes, and the count " +
      "of items scheduled into each. Pass a release `id` to update_item's " +
      "`releaseId` to schedule an item into it (the item must belong to the " +
      "release's product, or the release must be a portfolio release). Dated " +
      "releases come first (ascending target date), undated last.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const releases = await listReleases(ctx.scope);
      return releases.map((r) => ({
        id: r.id,
        name: r.name,
        productId: r.productId,
        status: r.status,
        startDate: r.startDate,
        targetDate: r.targetDate,
        notes: r.notes,
        itemCount: r.itemCount,
      }));
    },
  },
  {
    name: "create_release",
    description:
      'Create a release (a ship vehicle / version like "v0.18.0"). Provide a ' +
      "`name` (unique within its product); optionally `productId` to scope it " +
      "to a product (omit or pass null for a workspace-wide portfolio release " +
      "spanning every product), `status` (planned/in_progress/shipped, default " +
      "planned), `startDate` and `targetDate` (YYYY-MM-DD), and `notes` " +
      "(Markdown). A product release requires admin/contributor access to that " +
      "product; a portfolio release requires the workspace owner. Returns the " +
      "new release id, which you pass to update_item's `releaseId` to schedule " +
      "items into it.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Release name, unique within its product.",
        },
        productId: {
          type: ["string", "null"],
          description:
            "Product to scope the release to (from list_products); null or " +
            "omitted for a workspace-wide portfolio release.",
        },
        status: {
          type: "string",
          description: "planned | in_progress | shipped (default planned).",
        },
        startDate: {
          type: ["string", "null"],
          description: "Planned start date, YYYY-MM-DD.",
        },
        targetDate: {
          type: ["string", "null"],
          description: "Target ship date, YYYY-MM-DD.",
        },
        notes: {
          type: ["string", "null"],
          description: "Free-form release notes (Markdown).",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      // Per-product authorization is enforced in the store via
      // canWriteProductId: admin/contributor for a product release, owner for a
      // portfolio (null-product) release. No special owner-only gate here.
      const release = await createRelease(parseReleaseInput(args), ctx.scope);
      return {
        id: release.id,
        name: release.name,
        productId: release.productId,
        status: release.status,
        startDate: release.startDate,
        targetDate: release.targetDate,
        notes: release.notes,
        itemCount: release.itemCount,
      };
    },
  },
  {
    name: "update_release",
    description:
      "Update a release's metadata (change its ship dates, rename it, mark " +
      "it in_progress/shipped, edit its notes, or move it to another product). " +
      "Pass the release `id` (from list_releases) plus any of `name`, " +
      "`productId` (move to a product, or null for a workspace-wide portfolio " +
      "release), `status` (planned/in_progress/shipped), " +
      "`startDate`/`targetDate` (YYYY-MM-DD, or null to clear), and `notes` " +
      "(Markdown, or null to clear). Requires admin/contributor access to the " +
      "release's product (owner for a portfolio release). At least one field " +
      "must change. Returns the updated release.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Release id to update (from list_releases).",
        },
        name: {
          type: "string",
          description: "Release name, unique within its product.",
        },
        productId: {
          type: ["string", "null"],
          description:
            "Move the release to this product; null for a workspace-wide " +
            "portfolio release. Items no longer matching are unscheduled.",
        },
        status: {
          type: "string",
          description: "planned | in_progress | shipped.",
        },
        startDate: {
          type: ["string", "null"],
          description: "Planned start date, YYYY-MM-DD, or null to clear.",
        },
        targetDate: {
          type: ["string", "null"],
          description: "Target ship date, YYYY-MM-DD, or null to clear.",
        },
        notes: {
          type: ["string", "null"],
          description: "Free-form release notes (Markdown), or null to clear.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    run: async (args, ctx) => {
      // Per-product authorization is enforced in the store via
      // canWriteProductId against the release's product (owner for portfolio).
      if (typeof args.id !== "string" || args.id.trim() === "") {
        throw new Error("id must be a non-empty string.");
      }
      const release = await updateRelease(
        args.id,
        parseReleasePatch(args),
        ctx.scope,
      );
      return {
        id: release.id,
        name: release.name,
        productId: release.productId,
        status: release.status,
        startDate: release.startDate,
        targetDate: release.targetDate,
        notes: release.notes,
        itemCount: release.itemCount,
      };
    },
  },
];
