import { descendantGroupIds } from "@specboards/core";
import { eq, users, workspaces } from "@specboards/db";

import { getDb } from "@/lib/db";
import { resolveWorkflowFor } from "@/lib/repo-config";
import {
  createCycle,
  createGoal,
  createKeyResult,
  createRelease,
  createWorkItem,
  deleteGoal,
  deleteKeyResult,
  deleteWorkItem,
  getTransitionMode,
  listCycles,
  listGoalContributions,
  listGoals,
  listItemGoals,
  listReleases,
  parseCreateFeatureInput,
  parseFeaturePatch,
  linkGoal,
  parseCycleInput,
  parseCyclePatch,
  parseGoalInput,
  parseGoalPatch,
  parseKeyResultInput,
  parseKeyResultPatch,
  parseReleaseInput,
  parseReleaseNotesPatch,
  parseReleasePatch,
  patchFeature,
  rolloverCycle,
  unlinkGoal,
  updateCycle,
  updateGoal,
  updateKeyResult,
  updateRelease,
} from "@/lib/features-service";
import {
  addFeatureGithubLink,
  parseGithubLinkInput,
  removeFeatureGithubLink,
} from "@/lib/github-links-service";
import {
  createSpec,
  SpecConflictError,
  updateSpecContent,
} from "@/lib/spec-content";
import { getStore, type GithubLink } from "@/lib/store";

import { DOC_TOOLS } from "./doc-tools";
import {
  optionalString,
  requireDbScope,
  requireString,
  type McpTool,
} from "./types";

/**
 * The MCP tools Specboards exposes to coding agents. Each tool is a thin adapter
 * over the same service layer the REST API uses (`features-service`, the
 * `store`), so authorization, the status workflow, stage gates, and webhook
 * emission all behave identically to the web app - no logic is duplicated here.
 *
 * The Plan-section doc areas (Strategy / Research / Architecture) live in
 * `doc-tools.ts` and are appended to `TOOLS` below.
 */

export type { McpContext, McpTool } from "./types";

/** Shared JSON Schema fragment for a spec id argument. */
const specIdSchema = {
  type: "string",
  description: "The item's stable spec id (a UUID; see list_items).",
} as const;

/** Project a stored GitHub link down to the fields the MCP surface returns. */
function githubLinkOut(link: GithubLink) {
  return {
    id: link.id,
    kind: link.kind,
    number: link.number,
    branch: link.branch,
    url: link.url,
    title: link.title,
    state: link.state,
    inherited: link.inherited,
  };
}

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
    scope: { resource: "me", action: "read" },
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
      "List the status workflow: the ordered stage keys (use these " +
      "exact keys with update_item), each stage's display label, and the moves " +
      "allowed out of it, plus `transitionMode`. When the mode is `flexible`, " +
      "any stage reaches any other and a single update_item call can set any " +
      "status. When it is `strict`, stages must be walked in order (e.g. " +
      "`backlog` reaches only `defining` or `archived`): to move an item " +
      "several stages, pass update_item(advance: true) once - do NOT issue one " +
      "call per stage. Call this before changing an item's status so you never " +
      "have to guess a stage key. `transitionMode` is configured per product, " +
      "so pass `productId` (see list_products) when you are working in one " +
      "product; without it you get the workspace default, which may not be " +
      "what that product enforces. read_item's `allowedTransitions` is always " +
      "resolved for that item's own product.",
    inputSchema: {
      type: "object",
      properties: {
        productId: {
          type: "string",
          description:
            "Resolve transitions for this product. Omit for the workspace default.",
        },
      },
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "statuses", action: "read" },
    run: async (args, ctx) => {
      const productId = optionalString(args, "productId") ?? null;
      const [workflow, transitionMode] = await Promise.all([
        resolveWorkflowFor(ctx.scope ?? null, productId),
        getTransitionMode(ctx.scope, productId),
      ]);
      const titleCase = (key: string) =>
        key
          .split(/[_\s-]+/)
          .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
          .join(" ");
      return {
        transitionMode,
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
    scope: { resource: "products", action: "read" },
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
    scope: { resource: "product-groups", action: "read" },
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
    scope: { resource: "product-groups", action: "read" },
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
    scope: { resource: "features", action: "read" },
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
          cycleId: f.cycleId,
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
      "relations, parent, children, and the goals it ladders up to. This is " +
      "the 'review' view.",
    inputSchema: {
      type: "object",
      properties: { specId: specIdSchema },
      required: ["specId"],
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "features", action: "read" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      const f = await store.getFeature(specId, ctx.scope);
      if (!f) throw new Error(`No item with spec id ${specId}.`);
      // Advertise the moves update_item will accept from here, so agents step
      // the workflow instead of guessing stage keys (see list_statuses). The
      // goals answer the other half of the review question: why this exists.
      const [workflow, goals] = await Promise.all([
        // Resolved for this item's product, since transitions are configured
        // per product: an agent must be told what update_item will actually
        // accept for THIS item, not what the workspace default would allow.
        resolveWorkflowFor(ctx.scope ?? null, f.productId),
        listItemGoals(specId, ctx.scope),
      ]);
      return {
        specId: f.specId,
        title: f.title,
        level: f.level,
        isDbNative: f.isDbNative,
        status: f.status,
        allowedTransitions: workflow.transitions[f.status] ?? [],
        tags: f.tags,
        releaseId: f.releaseId,
        cycleId: f.cycleId,
        assigneeId: f.assigneeId,
        assigneeName: f.assigneeName,
        customFields: f.customFields,
        path: f.path,
        parentSpecId: f.parentSpecId,
        parentTitle: f.parentTitle,
        children: f.children,
        relations: f.relations,
        goals: goals.map((g) => ({
          id: g.goalId,
          title: g.title,
          status: g.status,
        })),
        content: f.content,
        // Hand back the sha `content` came from so an edit can be guarded
        // against whatever happens between this read and that write. Null for a
        // DB-native card, which has no file to race against.
        blobSha: f.blobSha,
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
    scope: { resource: "features", action: "read" },
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
      "Set any of: status, tags, releaseId, cycleId, assigneeId, customFields, " +
      "parentSpecId, and - for DB-native cards only - title and details " +
      "(Markdown body). Status changes are validated against the workspace " +
      "workflow and its stage gates. On a workspace whose transitions are " +
      "strict, a status several stages ahead is rejected: pass advance: true " +
      "and this walks the item through the intermediate stages in one call " +
      "(gates still apply at every stage it passes). A spec-backed item's " +
      "title and body come from git and cannot be patched here (Phase 2). Use " +
      "this to roll a summary of child specs up into a parent card's details.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        status: { type: "string" },
        advance: {
          type: "boolean",
          description:
            "Walk intermediate stages when the target status isn't reachable " +
            "in one move (strict workflows). Ignored without a status.",
        },
        tags: { type: "array", items: { type: "string" } },
        releaseId: { type: ["string", "null"] },
        cycleId: {
          type: ["string", "null"],
          description:
            "Cycle (sprint) to schedule into, from list_cycles. Independent " +
            "of releaseId: setting one never changes the other.",
        },
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
    scope: { resource: "features", action: "write" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      // parseFeaturePatch reads only known keys; specId/advance are ignored by it.
      const patch = parseFeaturePatch(args);
      const updated = await patchFeature(specId, patch, ctx.scope, {
        advance: args.advance === true,
      });
      return {
        specId: updated.specId,
        title: updated.title,
        status: updated.status,
        tags: updated.tags,
        releaseId: updated.releaseId,
        cycleId: updated.cycleId,
        isDbNative: updated.isDbNative,
      };
    },
  },
  {
    name: "delete_item",
    description:
      "Delete a work item. Its children are re-parented to the root (not " +
      "deleted) and its relations are cleared automatically. An item that has " +
      "a spec attached also needs `removeSpec: true`, which deletes its " +
      "spec.md from git in the same operation - without that the spec would " +
      "be re-imported on the next sync and the item would come back. This is " +
      "irreversible, so confirm the specId with read_item first.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        removeSpec: {
          type: "boolean",
          description:
            "Required to delete an item that has a spec attached; also " +
            "deletes the spec file from the connected repo.",
        },
      },
      required: ["specId"],
      additionalProperties: false,
    },
    write: true,
    // Only with `removeSpec`, but flagged unconditionally: see McpTool.commits.
    commits: true,
    scope: { resource: "features", action: "write" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      // Read first so we can echo back what was removed (and give a clear
      // error before attempting the delete if the id is unknown).
      const existing = await store.getFeature(specId, ctx.scope);
      if (!existing) throw new Error(`No item with spec id ${specId}.`);
      const removeSpec = args.removeSpec === true;
      await deleteWorkItem(specId, ctx.scope, { removeSpec });
      return {
        specId,
        title: existing.title,
        deleted: true,
        specRemoved: removeSpec && !existing.isDbNative,
      };
    },
  },
  {
    name: "create_item",
    description:
      "Create a work item at any level, including the leaf. Use it for a card " +
      "(initiative/epic/feature) and for leaf work that has no spec - a task " +
      "done by a person rather than by an agent. A spec is an optional " +
      "attachment to a leaf item, not a requirement for one, so leaf items " +
      "created here roll up into their parent exactly like spec-backed ones. " +
      "Use create_spec instead when the work needs a git-backed document. " +
      "`level` is any level key (see whoami). Optionally set product (key), " +
      "parentSpecId, status, assigneeId, tags, and details (Markdown body).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        level: {
          type: "string",
          description: "A level key from whoami (e.g. 'epic' or 'work').",
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
    scope: { resource: "features", action: "write" },
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
      "DB-native cards. This is how an agent edits an actual spec. Where the " +
      "change lands depends on the repo's writeMode: with `pr` (the default) " +
      "it is committed to a working branch and proposed as a pull request, " +
      "returned as `pullRequest`, and the board keeps showing the old text " +
      "until that is merged - do not report the spec as updated, report it as " +
      "proposed. A second edit to the same spec joins the open pull request.",
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
        expectedBlobSha: {
          type: "string",
          description:
            "The `blobSha` from the read_item you based this body on. The " +
            "write is refused if the spec changed in git since, rather than " +
            "overwriting whoever got there first. Pass it whenever you are " +
            "editing an existing body; omit it only when you are replacing " +
            "the spec wholesale and do not care what was there.",
        },
      },
      required: ["specId", "content"],
      additionalProperties: false,
    },
    write: true,
    commits: true,
    scope: { resource: "features", action: "write" },
    run: async (args, ctx) => {
      const { db, scope } = requireDbScope(ctx);
      const specId = requireString(args, "specId");
      const content = requireString(args, "content");
      const message =
        typeof args.message === "string" ? args.message : undefined;
      const expectedBlobSha =
        typeof args.expectedBlobSha === "string"
          ? args.expectedBlobSha
          : undefined;
      try {
        return await updateSpecContent(db, scope, specId, content, {
          message,
          expectedBlobSha,
        });
      } catch (err) {
        if (!(err instanceof SpecConflictError)) throw err;
        // Answer a conflict with everything needed to resolve it rather than an
        // error the agent can only retry. Re-reading is not a substitute: in PR
        // mode the version that won lives on a working branch, and read_item
        // would hand back the default branch's copy and send the agent round
        // the same loop with the same stale sha.
        return {
          conflict: true,
          message: err.message,
          path: err.path,
          currentContent: err.currentContent,
          currentBlobSha: err.currentBlobSha,
          howToResolve:
            "Merge your change into currentContent, then call this tool again " +
            "with expectedBlobSha set to currentBlobSha. Do not resend your " +
            "version unchanged: that discards whatever the other write said.",
        };
      }
    },
  },
  {
    name: "create_spec",
    description:
      "Commit a new specs/<slug>/spec.md to the connected repo and sync it " +
      "onto the board. Two uses: without `workItemId` a fresh work item is " +
      "created for the spec, which is how you break a card down into concrete " +
      "specs (create each one here, then call update_item with parentSpecId to " +
      "nest it under the card); with `workItemId` the spec ATTACHES to a work " +
      "item that already exists, keeping its id, status, assignee, parent and " +
      "history instead of creating a second card for the same work. Attach " +
      "when someone has been tracking the work in the app and it now needs a " +
      "document. Optionally target a repo by id (defaults to the spec repo).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: {
          type: "string",
          description: "Markdown body (no frontmatter). Defaults to a stub.",
        },
        workItemId: {
          type: "string",
          description:
            "An existing leaf work item (specId) to attach this spec to. It " +
            "must not already have one. Omit to create a new item.",
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
    commits: true,
    scope: { resource: "specs", action: "write" },
    run: async (args, ctx) => {
      const { db, scope } = requireDbScope(ctx);
      const title = requireString(args, "title");
      return createSpec(db, scope, {
        title,
        body: typeof args.body === "string" ? args.body : undefined,
        repoId: typeof args.repoId === "string" ? args.repoId : undefined,
        workItemId:
          typeof args.workItemId === "string" ? args.workItemId : undefined,
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
    scope: { resource: "releases", action: "read" },
    run: async (_args, ctx) => {
      const releases = await listReleases(ctx.scope);
      return releases.map((r) => ({
        id: r.id,
        name: r.name,
        productId: r.productId,
        status: r.status,
        startDate: r.startDate,
        targetDate: r.targetDate,
        shippedDate: r.shippedDate,
        notes: r.notes,
        releaseNotesMode: r.releaseNotesMode,
        releaseNotesBody: r.releaseNotesBody,
        releaseNotesUrl: r.releaseNotesUrl,
        customFields: r.customFields,
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
          description:
            "Internal planning notes (Markdown). Distinct from the " +
            "customer-facing release notes below.",
        },
        releaseNotesMode: {
          type: "string",
          description:
            "Customer-facing release-notes mode: none | in_app | external " +
            "(default none). `in_app` renders `releaseNotesBody` Markdown; " +
            "`external` links out to `releaseNotesUrl`.",
        },
        releaseNotesBody: {
          type: ["string", "null"],
          description: "In-app customer-facing release notes (Markdown).",
        },
        releaseNotesUrl: {
          type: ["string", "null"],
          description: "External release-notes URL (http/https) for `external` mode.",
        },
        customFields: {
          type: "object",
          description:
            "Values for release-scoped custom properties (defined in Settings), " +
            "keyed by property key. Values are string | number | boolean | " +
            "string[] | null.",
          additionalProperties: true,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "releases", action: "write" },
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
        shippedDate: release.shippedDate,
        notes: release.notes,
        releaseNotesMode: release.releaseNotesMode,
        releaseNotesBody: release.releaseNotesBody,
        releaseNotesUrl: release.releaseNotesUrl,
        customFields: release.customFields,
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
          description:
            "Internal planning notes (Markdown), or null to clear. Distinct " +
            "from the customer-facing release notes below.",
        },
        releaseNotesMode: {
          type: "string",
          description:
            "Customer-facing release-notes mode: none | in_app | external. " +
            "`in_app` renders `releaseNotesBody` Markdown; `external` links " +
            "out to `releaseNotesUrl`.",
        },
        releaseNotesBody: {
          type: ["string", "null"],
          description:
            "In-app customer-facing release notes (Markdown), or null to clear.",
        },
        releaseNotesUrl: {
          type: ["string", "null"],
          description:
            "External release-notes URL (http/https), or null to clear.",
        },
        customFields: {
          type: "object",
          description:
            "Values for release-scoped custom properties (defined in Settings), " +
            "keyed by property key. Replaces the whole map, so include every " +
            "value to keep. Values are string | number | boolean | string[] | null.",
          additionalProperties: true,
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "releases", action: "write" },
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
        shippedDate: release.shippedDate,
        notes: release.notes,
        releaseNotesMode: release.releaseNotesMode,
        releaseNotesBody: release.releaseNotesBody,
        releaseNotesUrl: release.releaseNotesUrl,
        customFields: release.customFields,
        itemCount: release.itemCount,
      };
    },
  },
  {
    name: "list_cycles",
    description:
      "List the workspace's cycles (sprints / iterations): the time boxes a " +
      "team works in. A cycle is a SECOND, ORTHOGONAL axis to releases, not a " +
      "kind of release: a release answers 'what ships together', a cycle " +
      "answers 'what is the team working on for the next two weeks'. An item " +
      "can be in a release AND a cycle at once, and setting one never touches " +
      "the other. Each cycle reports a derived `state` (upcoming / active / " +
      "complete) computed from its dates, so it is never stale, plus its item " +
      "and done counts. Ordered active first, then upcoming by soonest start, " +
      "then most recently complete. Pass a cycle `id` to update_item's " +
      "`cycleId` to schedule an item into it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    scope: { resource: "cycles", action: "read" },
    run: async (_args, ctx) => {
      const cycles = await listCycles(ctx.scope);
      return cycles.map((c) => ({
        id: c.id,
        name: c.name,
        productId: c.productId,
        startDate: c.startDate,
        endDate: c.endDate,
        state: c.state,
        notes: c.notes,
        itemCount: c.itemCount,
        doneCount: c.doneCount,
      }));
    },
  },
  {
    name: "create_cycle",
    description:
      'Create a cycle (a sprint / iteration like "Sprint 14"). Provide a ' +
      "`name` (unique within its product), `startDate` and `endDate` " +
      "(YYYY-MM-DD, both inclusive; the end cannot precede the start); " +
      "optionally `productId` to scope it to a product (omit or pass null for " +
      "a workspace-wide cycle spanning every product) and `notes` (Markdown, " +
      "e.g. the cycle's goal). There is deliberately no status to set: a " +
      "cycle is upcoming, active, or complete purely from its dates. A " +
      "product cycle requires admin/contributor access to that product; a " +
      "workspace-wide one requires the workspace owner.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Cycle name, unique within its product.",
        },
        startDate: {
          type: "string",
          description: "First day of the cycle, YYYY-MM-DD (inclusive).",
        },
        endDate: {
          type: "string",
          description: "Last day of the cycle, YYYY-MM-DD (inclusive).",
        },
        productId: {
          type: ["string", "null"],
          description:
            "Product to scope the cycle to (from list_products); null or " +
            "omitted for a workspace-wide cycle.",
        },
        notes: {
          type: ["string", "null"],
          description: "Free-form notes (Markdown), e.g. the cycle's goal.",
        },
      },
      required: ["name", "startDate", "endDate"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "cycles", action: "write" },
    run: async (args, ctx) => {
      const cycle = await createCycle(parseCycleInput(args), ctx.scope);
      return {
        id: cycle.id,
        name: cycle.name,
        productId: cycle.productId,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        state: cycle.state,
        notes: cycle.notes,
        itemCount: cycle.itemCount,
      };
    },
  },
  {
    name: "update_cycle",
    description:
      "Update a cycle's name, dates, notes, or owning product. Pass the cycle " +
      "`id` (from list_cycles) plus any of `name`, `startDate`, `endDate`, " +
      "`notes`, `productId`. Moving a cycle to a product unschedules items " +
      "belonging to other products, mirroring releases. There is no status " +
      "to set: moving the dates is what changes a cycle's state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Cycle id from list_cycles." },
        name: { type: "string" },
        startDate: { type: "string", description: "YYYY-MM-DD." },
        endDate: { type: "string", description: "YYYY-MM-DD." },
        notes: { type: ["string", "null"] },
        productId: {
          type: ["string", "null"],
          description: "Move to a product, or null for workspace-wide.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "cycles", action: "write" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      const { id: _omit, ...rest } = args;
      const cycle = await updateCycle(id, parseCyclePatch(rest), ctx.scope);
      return {
        id: cycle.id,
        name: cycle.name,
        productId: cycle.productId,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        state: cycle.state,
        notes: cycle.notes,
        itemCount: cycle.itemCount,
        doneCount: cycle.doneCount,
      };
    },
  },
  {
    name: "rollover_cycle",
    description:
      "Move a cycle's UNFINISHED work into another cycle, which is how a team " +
      "closes one cycle and opens the next. Items already done or archived " +
      "stay where they are, so the finished cycle keeps an honest record of " +
      "what it actually delivered. Deliberately an explicit action rather " +
      "than something that happens when a cycle's end date passes: what " +
      "carries over is a decision, not a rule. Pass `fromCycleId` and " +
      "`toCycleId` (both from list_cycles); returns how many items moved.",
    inputSchema: {
      type: "object",
      properties: {
        fromCycleId: {
          type: "string",
          description: "The cycle being closed.",
        },
        toCycleId: {
          type: "string",
          description: "The cycle its unfinished work moves into.",
        },
      },
      required: ["fromCycleId", "toCycleId"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "cycles", action: "write" },
    run: async (args, ctx) => {
      const fromCycleId = requireString(args, "fromCycleId");
      const toCycleId = requireString(args, "toCycleId");
      return rolloverCycle(fromCycleId, toCycleId, ctx.scope);
    },
  },
  {
    name: "list_goals",
    description:
      "List the workspace's goals (objectives) with their key results. A goal " +
      "says WHY work exists in a form that can be measured; it is NOT a " +
      "hierarchy level, because a goal is measured and the work serving it is " +
      "many-to-many and crosses products, neither of which the single-parent " +
      "item hierarchy can carry. Each goal reports TWO progress figures, both " +
      "computed on read and never stored: `progress` is the mean of its key " +
      "results (did the outcome move?) and `deliveryProgress` is the share of " +
      "linked work that is done (did we ship it?). They are deliberately " +
      "separate - everything shipping while no metric moves is exactly what " +
      "goals exist to make visible, so do not average them together. " +
      "`status` is the owner's confidence call, not arithmetic.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    write: false,
    scope: { resource: "goals", action: "read" },
    run: async (_args, ctx) => {
      const goals = await listGoals(ctx.scope);
      return goals.map((g) => ({
        id: g.id,
        title: g.title,
        description: g.description,
        productId: g.productId,
        parentGoalId: g.parentGoalId,
        periodStart: g.periodStart,
        periodEnd: g.periodEnd,
        status: g.status,
        progress: g.progress,
        deliveryProgress: g.deliveryProgress,
        linkedItemCount: g.linkedItemCount,
        keyResults: g.keyResults.map((kr) => ({
          id: kr.id,
          title: kr.title,
          metricKind: kr.metricKind,
          startValue: kr.startValue,
          currentValue: kr.currentValue,
          targetValue: kr.targetValue,
          progress: kr.progress,
        })),
      }));
    },
  },
  {
    name: "read_goal",
    description:
      "Read one goal in full: its key results with their measurements, both " +
      "progress figures, and - the part list_goals leaves out - the work " +
      "items linked to it, each with its status and whether it counts as " +
      "done. Use this before changing a goal, and to answer 'what are we " +
      "actually doing about this objective?'. Pass the goal `id` from " +
      "list_goals.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal id from list_goals." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "goals", action: "read" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      const goals = await listGoals(ctx.scope);
      const goal = goals.find((g) => g.id === id);
      if (!goal) throw new Error(`No goal with id ${id}.`);
      const contributions = await listGoalContributions(id, ctx.scope);
      return {
        id: goal.id,
        title: goal.title,
        description: goal.description,
        productId: goal.productId,
        parentGoalId: goal.parentGoalId,
        periodStart: goal.periodStart,
        periodEnd: goal.periodEnd,
        status: goal.status,
        progress: goal.progress,
        deliveryProgress: goal.deliveryProgress,
        keyResults: goal.keyResults.map((kr) => ({
          id: kr.id,
          title: kr.title,
          metricKind: kr.metricKind,
          startValue: kr.startValue,
          currentValue: kr.currentValue,
          targetValue: kr.targetValue,
          progress: kr.progress,
        })),
        linkedItems: contributions.map((c) => ({
          specId: c.specId,
          title: c.title,
          level: c.level,
          status: c.status,
          done: c.done,
          productId: c.productId,
        })),
      };
    },
  },
  {
    name: "create_goal",
    description:
      "Create a goal (objective). Provide a `title`; optionally " +
      "`description`, `productId` (omit or null for an org-wide goal spanning " +
      "every product), `periodStart` / `periodEnd` (YYYY-MM-DD; either may be " +
      "omitted for an open-ended goal), `parentGoalId` to nest it under a " +
      "wider objective, and `status`. Add key results with create_key_result " +
      "and link the work that serves it with link_goal. A goal with no key " +
      "results yet is a valid state and reads as 'not measured', not 0%.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: ["string", "null"] },
        productId: {
          type: ["string", "null"],
          description:
            "Product to scope the goal to (from list_products); null or " +
            "omitted for an org-wide goal.",
        },
        periodStart: { type: ["string", "null"], description: "YYYY-MM-DD." },
        periodEnd: { type: ["string", "null"], description: "YYYY-MM-DD." },
        parentGoalId: { type: ["string", "null"] },
        status: {
          type: "string",
          description:
            "on_track | at_risk | off_track | achieved | missed (default on_track).",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "goals", action: "write" },
    run: async (args, ctx) => {
      const goal = await createGoal(parseGoalInput(args), ctx.scope);
      return { id: goal.id, title: goal.title, status: goal.status };
    },
  },
  {
    name: "update_goal",
    description:
      "Update a goal's title, description, period, product, parent, or " +
      "status. Pass the goal `id` (from list_goals). Note that `status` is " +
      "the owner's confidence call and is independent of the computed " +
      "progress: a goal can be 80% of the way to target and still be " +
      "off_track, or at 20% early in its period and perfectly on_track. To " +
      "move progress, update a key result's currentValue instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal id from list_goals." },
        title: { type: "string" },
        description: { type: ["string", "null"] },
        productId: { type: ["string", "null"] },
        periodStart: { type: ["string", "null"] },
        periodEnd: { type: ["string", "null"] },
        parentGoalId: { type: ["string", "null"] },
        status: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "goals", action: "write" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      const { id: _omit, ...rest } = args;
      const goal = await updateGoal(id, parseGoalPatch(rest), ctx.scope);
      return {
        id: goal.id,
        title: goal.title,
        status: goal.status,
        progress: goal.progress,
      };
    },
  },
  {
    name: "delete_goal",
    description:
      "Delete a goal. Its key results and every link from work to it go with " +
      "it; the work items themselves are untouched, they simply stop " +
      "laddering up to anything. Goals nested underneath it are NOT deleted: " +
      "they move to the top level, so re-parent them with " +
      "update_goal(parentGoalId) if they belong under something else. This is " +
      "irreversible and discards the goal's measurement history, so read_goal " +
      "it first and prefer update_goal(status) - `achieved` or `missed` - for " +
      "a goal whose period simply ended.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Goal id from list_goals." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "goals", action: "write" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      // Read first so the response can name what was removed, and so an
      // unknown id fails before anything is deleted.
      const goals = await listGoals(ctx.scope);
      const goal = goals.find((g) => g.id === id);
      if (!goal) throw new Error(`No goal with id ${id}.`);
      const contributions = await listGoalContributions(id, ctx.scope);
      await deleteGoal(id, ctx.scope);
      return {
        id,
        title: goal.title,
        deleted: true,
        keyResultsRemoved: goal.keyResults.length,
        itemsUnlinked: contributions.length,
      };
    },
  },
  {
    name: "create_key_result",
    description:
      "Add a key result (a measurable outcome) to a goal. Provide `goalId`, " +
      "`title` and `targetValue`; optionally `metricKind` (number / percent / " +
      "boolean), `startValue` (the baseline, default 0) and `currentValue`. " +
      "Progress is measured as the distance travelled from start to target, " +
      "so ALWAYS set `startValue` to the real baseline: a metric that starts " +
      "at 40 and targets 60 reads 0% at 40, not 67%. Decreasing metrics work " +
      "with no special case (start 8, target 3). The target must differ from " +
      "the start. Returns the goal with its recomputed progress.",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string" },
        title: { type: "string" },
        targetValue: { type: "number" },
        metricKind: {
          type: "string",
          description: "number | percent | boolean (default number).",
        },
        startValue: { type: "number", description: "Baseline; default 0." },
        currentValue: { type: "number", description: "Defaults to startValue." },
      },
      required: ["goalId", "title", "targetValue"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "key-results", action: "write" },
    run: async (args, ctx) => {
      const goalId = requireString(args, "goalId");
      const { goalId: _omit, ...rest } = args;
      const goal = await createKeyResult(
        goalId,
        parseKeyResultInput(rest),
        ctx.scope,
      );
      return { id: goal.id, title: goal.title, progress: goal.progress };
    },
  },
  {
    name: "update_key_result",
    description:
      "Update a key result, most often its `currentValue` as you check in on " +
      "the metric. Pass the key result `id` (from list_goals) plus any of " +
      "`title`, `metricKind`, `startValue`, `targetValue`, `currentValue`. " +
      "Returns the goal with its recomputed progress.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        metricKind: { type: "string" },
        startValue: { type: "number" },
        targetValue: { type: "number" },
        currentValue: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "key-results", action: "write" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      const { id: _omit, ...rest } = args;
      const goal = await updateKeyResult(
        id,
        parseKeyResultPatch(rest),
        ctx.scope,
      );
      return {
        id: goal.id,
        title: goal.title,
        progress: goal.progress,
        keyResults: goal.keyResults.map((kr) => ({
          id: kr.id,
          title: kr.title,
          currentValue: kr.currentValue,
          progress: kr.progress,
        })),
      };
    },
  },
  {
    name: "delete_key_result",
    description:
      "Remove a key result from its goal, for a measure that turned out to " +
      "be the wrong one. The goal's `progress` is the mean of what remains, " +
      "so deleting a lagging measure MOVES THE GOAL'S NUMBER - to stop " +
      "tracking a metric without rewriting history, consider leaving it and " +
      "letting the goal read honestly instead. Pass the key result `id` from " +
      "list_goals or read_goal; returns the goal with its recomputed progress.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Key result id (from list_goals / read_goal).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "key-results", action: "write" },
    run: async (args, ctx) => {
      const id = requireString(args, "id");
      const goal = await deleteKeyResult(id, ctx.scope);
      return {
        id: goal.id,
        title: goal.title,
        progress: goal.progress,
        keyResults: goal.keyResults.map((kr) => ({
          id: kr.id,
          title: kr.title,
          currentValue: kr.currentValue,
          progress: kr.progress,
        })),
      };
    },
  },
  {
    name: "link_goal",
    description:
      "Record that a work item ladders up to a goal, which is how you say " +
      "WHY the work exists. Many-to-many and reachable from ANY level: an " +
      "initiative and a single work item can both contribute, one item can " +
      "serve several goals, and the item may belong to a different product " +
      "than the goal (cross-product linkage is the point). Pass `goalId` and " +
      "the item's `specId`. Linking something already linked is a no-op. Use " +
      "`unlink: true` to remove the link instead.",
    inputSchema: {
      type: "object",
      properties: {
        goalId: { type: "string" },
        specId: specIdSchema,
        unlink: {
          type: "boolean",
          description: "Remove the link rather than create it.",
        },
      },
      required: ["goalId", "specId"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "goals", action: "write" },
    run: async (args, ctx) => {
      const goalId = requireString(args, "goalId");
      const specId = requireString(args, "specId");
      if (args.unlink === true) {
        await unlinkGoal(goalId, specId, ctx.scope);
      } else {
        await linkGoal(goalId, specId, ctx.scope);
      }
      const contributions = await listGoalContributions(goalId, ctx.scope);
      return {
        goalId,
        specId,
        linked: args.unlink !== true,
        contributionCount: contributions.length,
      };
    },
  },
  {
    name: "update_release_notes",
    description:
      "Author a release's CUSTOMER-FACING release notes (distinct from the " +
      "internal planning `notes` set by update_release, which this tool never " +
      "touches). Pass the release `id` (from list_releases) plus either an " +
      "in-app `body` (Markdown, rendered read-only in the app) or an external " +
      "`url` (an http(s) link the app points out to), not both. The mode is " +
      "inferred: a non-empty `body` selects `in_app`, a non-empty `url` selects " +
      "`external`, and clearing the payload resets it to `none`; pass `mode` " +
      "explicitly to override. The stored body and url are retained across mode " +
      "switches, so selecting one never clobbers the other's value. Requires " +
      "admin/contributor access to the release's product (owner for a portfolio " +
      "release). Returns the updated release-notes state.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Release id whose notes to author (from list_releases).",
        },
        mode: {
          type: "string",
          description:
            "Optional explicit mode: none | in_app | external. Usually left " +
            "off and inferred from `body`/`url`.",
        },
        body: {
          type: ["string", "null"],
          description:
            "In-app customer-facing release notes (Markdown). Non-empty selects " +
            "in_app mode; null/empty clears the in-app notes.",
        },
        url: {
          type: ["string", "null"],
          description:
            "External release-notes URL (http/https). Non-empty selects " +
            "external mode; null/empty clears the external link.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "releases", action: "write" },
    run: async (args, ctx) => {
      // Reuses updateRelease so authorization (canWriteProductId: admin/
      // contributor for a product release, owner for portfolio) matches
      // update_release exactly. The patch is release-notes-only, so this tool
      // can never rename, reschedule, or edit the internal planning notes.
      if (typeof args.id !== "string" || args.id.trim() === "") {
        throw new Error("id must be a non-empty string.");
      }
      const release = await updateRelease(
        args.id,
        parseReleaseNotesPatch(args),
        ctx.scope,
      );
      return {
        id: release.id,
        name: release.name,
        releaseNotesMode: release.releaseNotesMode,
        releaseNotesBody: release.releaseNotesBody,
        releaseNotesUrl: release.releaseNotesUrl,
      };
    },
  },
  {
    name: "list_github_links",
    description:
      "List a work item's linked GitHub artifacts (pull requests, issues, " +
      "branches). Each link carries its id, kind, PR/issue number or branch " +
      "name, url, cached title and state (open/closed/merged), and `inherited` " +
      "(true when rolled up from a descendant item rather than linked directly " +
      "here). read_item omits these, so use this to see or verify an item's " +
      "GitHub links - for example after link_github.",
    inputSchema: {
      type: "object",
      properties: { specId: specIdSchema },
      required: ["specId"],
      additionalProperties: false,
    },
    write: false,
    scope: { resource: "features", action: "read" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const store = await getStore();
      const f = await store.getFeature(specId, ctx.scope);
      if (!f) throw new Error(`No item with spec id ${specId}.`);
      return {
        specId: f.specId,
        title: f.title,
        githubLinks: f.githubLinks.map(githubLinkOut),
      };
    },
  },
  {
    name: "link_github",
    description:
      "Attach a GitHub artifact to a work item by spec id, closing the loop " +
      "after you open a PR for the item. Pass `kind` plus its identifier: " +
      "`pull_request` or `issue` with a positive integer `number`, or `branch` " +
      "with a `branch` name. The PR/issue/branch must exist in the item's " +
      "connected repository; its title, state, and url are resolved from GitHub " +
      "and cached. Re-linking the same artifact refreshes that cached metadata. " +
      "The repository is inferred from the item (a spec's own repo, else its " +
      "product's, else the workspace's); pass `repo` as \"owner/name\" only " +
      "when the workspace has several connected repos and the error asks you " +
      "to choose. Requires write access to the item's product. Returns the " +
      "resolved link and the item's refreshed link list.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        kind: {
          type: "string",
          enum: ["pull_request", "issue", "branch"],
          description: "The kind of GitHub artifact to link.",
        },
        number: {
          type: "integer",
          description:
            "The pull request or issue number (required for pull_request " +
            "and issue; omit for branch).",
        },
        branch: {
          type: "string",
          description: "The branch name (required for branch; omit otherwise).",
        },
        repo: {
          type: "string",
          description:
            'Which connected repository the artifact lives in, as "owner/name". ' +
            "Optional: omit it and the repo is inferred from the item.",
        },
      },
      required: ["specId", "kind"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "features", action: "write" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      // Reuse the app's validation and GitHub resolution end to end; the store
      // enforces per-product write access, matching the web link action.
      const input = parseGithubLinkInput(args);
      const links = await addFeatureGithubLink(specId, input, ctx.scope);
      // Surface the link we just resolved (matched by kind + number/branch).
      const linked = links.find(
        (l) =>
          !l.inherited &&
          l.kind === input.kind &&
          (input.kind === "branch"
            ? l.branch === input.branch
            : l.number === input.number),
      );
      return {
        specId,
        linked: linked ? githubLinkOut(linked) : null,
        githubLinks: links.map(githubLinkOut),
      };
    },
  },
  {
    name: "unlink_github",
    description:
      "Remove a GitHub link from a work item by the link's id (from " +
      "list_github_links). Only a link added directly to this item can be " +
      "removed; an inherited link lives on the descendant item it was linked " +
      "to. Requires write access to the item's product. Returns the item's " +
      "refreshed link list.",
    inputSchema: {
      type: "object",
      properties: {
        specId: specIdSchema,
        linkId: {
          type: "string",
          description: "The link's id (from list_github_links).",
        },
      },
      required: ["specId", "linkId"],
      additionalProperties: false,
    },
    write: true,
    scope: { resource: "features", action: "write" },
    run: async (args, ctx) => {
      const specId = requireString(args, "specId");
      const linkId = requireString(args, "linkId");
      const links = await removeFeatureGithubLink(specId, linkId, ctx.scope);
      return { specId, githubLinks: links.map(githubLinkOut) };
    },
  },
  // Strategy / Research / Architecture: the narrative plan the work delivers.
  ...DOC_TOOLS,
];
