import { eq, users, workspaces } from "@specboard/db";

import { getDb } from "@/lib/db";
import {
  createWorkItem,
  parseCreateFeatureInput,
  parseFeaturePatch,
  patchFeature,
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
    name: "list_products",
    description:
      "List the products (sibling backlogs) the caller can see. Each product " +
      "has its own hierarchy of items. Use a product's `key` to filter " +
      "list_items, or its `id` for create_item.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    run: async (_args, ctx) => {
      const store = await getStore();
      const products = await store.listProducts(ctx.scope);
      return products.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        itemCount: p.itemCount,
      }));
    },
  },
  {
    name: "list_items",
    description:
      "List work items (specs and DB-native cards) in the caller's workspace " +
      "with their metadata. Optionally filter by status, product key, or " +
      "assignee user id. Returns lean rows; call read_item for full content.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter to one status key." },
        product: {
          type: "string",
          description: "Filter to one product by its key (see list_products).",
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
      const status = typeof args.status === "string" ? args.status : undefined;
      const assignee =
        typeof args.assignee === "string" ? args.assignee : undefined;
      return features
        .filter(
          (f) =>
            (!status || f.status === status) &&
            (!assignee || f.assigneeId === assignee) &&
            (!productId || f.productId === productId),
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
      return {
        specId: f.specId,
        title: f.title,
        level: f.level,
        isDbNative: f.isDbNative,
        status: f.status,
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
];
