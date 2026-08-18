import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Specboards data model. Spec *content* is canonical in git; this DB holds the
 * *metadata* (status/assignment/priority/ordering) plus a cached index of spec
 * content for fast boards and querying. Every tenant-scoped row carries
 * `workspaceId` so Postgres RLS can isolate tenants (see migrations).
 */

/**
 * A workspace role. `owner` administers everything; `member` is the org
 * baseline (write only via per-product grants); `service` is a non-human
 * machine account (sync bots, CI) that behaves like a `member` for
 * product-scoped writes but is surfaced distinctly so automated activity is
 * clearly attributed, and can never be an org owner.
 */
export const memberRole = pgEnum("member_role", ["owner", "member", "service"]);

/** A product's read visibility: `org` (every member can read) or `private`
 * (read requires org-admin or explicit product membership). */
export const productVisibility = pgEnum("product_visibility", [
  "org",
  "private",
]);

/** A user's role on a single product: `admin` (manage product + members + edit
 * items), `editor` (edit items), `viewer` (read — only meaningful for private
 * products, where it grants access). */
export const productMemberRole = pgEnum("product_member_role", [
  "admin",
  "contributor",
  "viewer",
]);

/** Lifecycle of an org invitation. `pending` until it is redeemed
 * (`accepted`), revoked by an admin (`revoked`), or lapses past its expiry
 * (`expired`, flipped lazily on the next read of a stale row). */
export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

/** Where a pre-v1 access request sits in the review queue. `pending` until a
 * team member decides it in the admin portal: `approved` (the requester was
 * emailed the sign-up code) or `declined` (no email is sent). */
export const accessRequestStatus = pgEnum("access_request_status", [
  "pending",
  "approved",
  "declined",
]);

/** Tenant root. SaaS has many; a self-host install typically has one. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /**
   * @deprecated Superseded by `product_settings.transition_mode`. Migration
   * 0064 copied every workspace's value into its default `product_settings`
   * row and nothing reads this column any more. It survives only so the
   * previously-deployed version keeps working across a release or a rollback;
   * a follow-up migration drops it. Do not read or write it.
   */
  transitionMode: text("transition_mode").notNull().default("flexible"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A workspace's work-tracking hierarchy levels (e.g. Initiative → Epic →
 * Feature). Seeded with the default three levels per workspace; teams edit
 * depth/labels in Settings. The deepest level (`is_leaf`) is the git-backed
 * spec; higher levels are DB-native. `features.level` is a composite FK into
 * (workspace_id, key) here, so a feature's level always belongs to its own
 * workspace and can never reference an unknown key.
 */
export const workspaceLevels = pgTable(
  "workspace_levels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** Depth, ascending: 0 is the top level; the largest is the leaf. */
    position: integer("position").notNull(),
    isLeaf: boolean("is_leaf").notNull().default(false),
    /**
     * Metadata field keys available on items at this level (see
     * lib/card-fields metadata catalog). NULL = every field is available.
     */
    cardFields: jsonb("card_fields"),
    /**
     * Default detail template seeded into a new item's body at this level, or
     * NULL for a blank body. Cleared (SET NULL) if the template is deleted.
     */
    detailTemplateId: uuid("detail_template_id").references(
      () => detailTemplates.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_levels_ws_key_uq").on(t.workspaceId, t.key),
    index("workspace_levels_ws_idx").on(t.workspaceId),
  ],
);

/**
 * An admin-defined "Details Template" (Settings -> Cards): a Markdown skeleton
 * of headings/body that seeds a new card's details. A level can point at one as
 * its default via `workspace_levels.detail_template_id`.
 */
export const detailTemplates = pgTable(
  "detail_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Owning product, or NULL for the workspace default. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    /** Markdown body used as the starting point for a card's details. */
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Uniqueness is a pair of partial indexes; see migration 0065.
    index("detail_templates_ws_idx").on(t.workspaceId),
    index("detail_templates_product_idx").on(t.productId),
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "detail_templates_product_ws_fk",
    }),
  ],
);

/**
 * A product group: a management-level node that collects products (and other
 * groups, via `parent_id`) into parts of the customer's platform so their
 * content can be rolled up. Group metadata (name/key/color) is member-visible
 * like releases; roll-up surfaces hide groups whose subtree holds no readable
 * product, and aggregates are computed only over readable products (enforced
 * in the app layer; see plan). Cycle/depth invariants are enforced in the
 * store transaction, not by trigger: writes are org-admin-only and the
 * composite parent FK already rules out the cross-workspace variant.
 */
export const productGroups = pgTable(
  "product_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Parent group for nesting; null = top-level. */
    parentId: uuid("parent_id").references((): AnyPgColumn => productGroups.id),
    /** Stable slug used as the `~{key}` scope segment in product-slot URLs. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Accent-color token (core `PRODUCT_COLORS`), or null. */
    color: text("color"),
    /** Manual sibling ordering; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("product_groups_ws_key_uq").on(t.workspaceId, t.key),
    // Target for composite FKs (self + products.group_id) so a parent/member
    // in another workspace is impossible at the DB level.
    unique("product_groups_id_ws_uq").on(t.id, t.workspaceId),
    index("product_groups_ws_idx").on(t.workspaceId),
    index("product_groups_parent_idx").on(t.parentId),
    foreignKey({
      columns: [t.parentId, t.workspaceId],
      foreignColumns: [t.id, t.workspaceId],
      name: "product_groups_parent_ws_fk",
    }),
  ],
);

/**
 * A product: a sibling backlog within the organization (the workspace). Each
 * product holds its own work-tracking hierarchy (Initiative → Epic → Feature)
 * via `features.product_id`. `visibility` gates reads: `org` products are
 * readable by every member; `private` products require org-admin or a
 * `product_members` row. `key` is the stable slug used in the `?product=` URL.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: productVisibility("visibility").notNull().default("org"),
    /** Accent-color token (see core `PRODUCT_COLORS`). Nullable: a null row
     * derives a stable color from its key via `resolveProductColor`. */
    color: text("color"),
    /** Product group this product belongs to; null = ungrouped. At most one
     * group per product. The store blocks deleting a populated group, so the
     * composite FK's default NO ACTION is only a backstop. */
    groupId: uuid("group_id"),
    /** Manual ordering in the product switcher; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("products_ws_key_uq").on(t.workspaceId, t.key),
    // Target for composite FKs (e.g. product_repositories) scoping by tenant.
    unique("products_id_ws_uq").on(t.id, t.workspaceId),
    index("products_ws_idx").on(t.workspaceId),
    index("products_group_idx").on(t.groupId),
    foreignKey({
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [productGroups.id, productGroups.workspaceId],
      name: "products_group_ws_fk",
    }),
  ],
);

/**
 * A user's role on a single product. Write access to a product's items comes
 * from an `admin`/`editor` row here (or being an org admin); a `viewer` row
 * grants read access to a `private` product. `userId` has no FK for the same
 * reason as `members.user_id` (auth-disabled self-host).
 */
export const productMembers = pgTable(
  "product_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: productMemberRole("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("product_members_product_user_uq").on(t.productId, t.userId),
    index("product_members_product_idx").on(t.productId),
    index("product_members_user_idx").on(t.userId),
  ],
);

/**
 * Cards configuration, scoped to a product. One row per product, plus one row
 * per workspace with a NULL `productId` holding the workspace-wide default that
 * products inherit from.
 *
 * Every column is nullable and means "inherit" when null, which is why the
 * table exists at all rather than columns on `products`: a product needs to
 * express "I have not overridden this" separately from "I have no settings",
 * so reverting an override is a null rather than a delete of the row the other
 * Cards settings also live on.
 *
 * Resolution reads at most two rows (the product's and the workspace default)
 * and takes the first non-null value. RLS keys writes to
 * `specboards_can_manage_product` for a product row and `specboards_is_org_admin`
 * for the default row; the uniqueness of the default row is a partial index
 * (Drizzle can't express one, so it is in migration 0064 by hand).
 */
export const productSettings = pgTable(
  "product_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** NULL = the workspace-wide default row every product falls back to. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /**
     * How freely items move between workflow stages: `strict` is a pipeline
     * (one step forward, one back, or archive), `flexible` lets any stage reach
     * any other. NULL inherits the workspace default. Stage gates apply in both
     * modes. See TransitionMode in @specboards/core.
     */
    transitionMode: text("transition_mode"),
    /**
     * Per-level built-in field visibility: `{levelKey: string[] | null}`.
     *
     * A map rather than a `product_id` on `workspace_levels`, because levels
     * are workspace-wide (Settings > Hierarchy, not a Cards setting) and there
     * is only one row per level to hang an override on.
     *
     * An ABSENT level inherits the workspace default for that level; a level
     * present with `null` overrides it to "every field available". That
     * distinction is what makes adding a level safe: a new level is in nobody's
     * map, so every product inherits it rather than being silently narrowed.
     */
    cardFields: jsonb("card_fields"),
    /** Per-level default detail template: `{levelKey: uuid | null}`. Same
     * absent-inherits/present-overrides rule as {@link cardFields}. */
    levelTemplates: jsonb("level_templates"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "product_settings_product_ws_fk",
    }),
  ],
);

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // References users.id, but deliberately without an FK so a
    // single-workspace self-host can run with auth disabled.
    userId: uuid("user_id").notNull(),
    role: memberRole("role").notNull().default("member"),
    /** When non-null the membership is suspended: the user keeps their row (and
     * any per-product grants) but is denied all access to this org. Deactivation
     * is per-org, so a user can stay active elsewhere. Enforced centrally in
     * `getMembership`/`getMembershipFor`. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("members_workspace_user_uq").on(t.workspaceId, t.userId)],
);

/**
 * A pending email invitation to join a workspace with a chosen role. The raw
 * token is emailed once as an `/invite/<token>` link; only its SHA-256
 * (`tokenHash`) is stored, mirroring `api_keys`. A partial-unique index on
 * `(workspace_id, lower(email)) where status = 'pending'` (added in the
 * migration by hand — Drizzle can't express it) keeps at most one live invite
 * per email per org. `invitedBy`/`acceptedUserId` reference `users.id` without
 * an FK for the same reason as `members.user_id`.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Invited address, stored lowercased; the redeeming user's email must match. */
    email: text("email").notNull(),
    /** Org role granted on accept: `owner` (workspace admin) or `member`. */
    role: memberRole("role").notNull().default("member"),
    /** Per-product grants applied on accept: `[{ productId, role }]`, where role
     * is a product role (admin/contributor/viewer). Empty for an owner invite
     * (owner is admin on every product). */
    productGrants: jsonb("product_grants").notNull().default([]),
    /** SHA-256 hex of the raw token; the plaintext lives only in the emailed link. */
    tokenHash: text("token_hash").notNull().unique(),
    status: invitationStatus("status").notNull().default("pending"),
    invitedBy: uuid("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: uuid("accepted_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("invitations_ws_idx").on(t.workspaceId),
    index("invitations_email_idx").on(t.email),
    index("invitations_token_idx").on(t.tokenHash),
  ],
);

/**
 * The deployment's GitHub App credentials, created via the in-app manifest
 * flow. Deployment-global config (one App per deployment, not per tenant), so
 * NO `workspaceId` and NO RLS — it's read/written only through the owner
 * connection (`getDb`). `privateKey` and `webhookSecret` are encrypted at rest.
 */
export const githubApp = pgTable("github_app", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: text("app_id").notNull(),
  slug: text("slug").notNull(),
  clientId: text("client_id"),
  /**
   * OAuth client secret for the App's "identify users" flow, encrypted at
   * rest. The install callback uses it to verify the installing user actually
   * administers the GitHub account the installation belongs to. Null for Apps
   * saved before this column existed; those fall back to env credentials.
   */
  clientSecret: text("client_secret"),
  /** PEM, encrypted at rest (AES-256-GCM keyed off BETTER_AUTH_SECRET). */
  privateKey: text("private_key").notNull(),
  /** Webhook signing secret, encrypted at rest. */
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Better Auth's rate-limit counters (its `rateLimit` model). Backing the
 * limiter with the database instead of process memory makes the auth / DCR
 * limits hold across instances (the hosted app can scale past one machine).
 * Deployment-global operational data: no `workspaceId`, no RLS, owner
 * connection only. Better Auth reads/writes `key`, `count`, `lastRequest`.
 */
export const rateLimits = pgTable("rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  /** Epoch millis of the window's first request; Better Auth stores a number. */
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/**
 * Fixed-window quota counters for expensive API operations (repo scan/import/
 * starter-spec/connect, webhook test sends). Keyed by an opaque string like
 * `scan:<workspaceId>`; `windowStart` anchors the current window and `count`
 * is the requests seen in it. Enforced atomically in `lib/rate-limit.ts`.
 * Operational data, owner connection only (no RLS).
 */
export const operationLimits = pgTable("operation_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A pre-v1 "Request access" submission from the marketing site, and the team's
 * decision on it. The public `POST /api/access-request` route writes the row
 * (and still sends the notification / confirmation emails); the internal admin
 * portal (a separate app, over the org's private network) lists the queue and
 * marks a row approved or declined, emailing an approved requester the sign-up
 * code that `access-gate.ts` checks, which is what actually opens the door.
 * This app has no admin API for that: the portal's Postgres role is granted
 * UPDATE on this one table, which is why nothing here writes the decision
 * columns.
 *
 * Deployment-global, no tenant dimension (the requester has no workspace yet),
 * so no `workspaceId`. Unlike `githubApp` this table is RLS-enabled with NO
 * policies: it holds contact details for people who are not customers, and
 * deny-all means the tenant-scoped `specboards_app` connection cannot read it
 * even by accident. This app's writes run on the owner connection (`getDb`).
 *
 * At most one `pending` row per email address (partial unique index): a repeat
 * submission refreshes the open request instead of queueing a duplicate.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Stored lowercased, like `invitations.email`. */
    email: text("email").notNull(),
    company: text("company").notNull(),
    /** Free text from the form's range picker ("2-10"), blank if not given. */
    teamSize: text("team_size").notNull().default(""),
    useCase: text("use_case").notNull(),
    status: accessRequestStatus("status").notNull().default("pending"),
    /** Email of the admin who decided it; null while pending. */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Set when the approval email actually left Postmark, so a send failure
     * is visible in the queue rather than silently assumed. */
    codeSentAt: timestamp("code_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("access_requests_status_idx").on(t.status),
    index("access_requests_created_at_idx").on(t.createdAt),
    uniqueIndex("access_requests_pending_email_uq")
      .on(t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * GitHub webhook deliveries already processed, keyed by the `x-github-delivery`
 * id. The insert IS the dedup check: a primary-key conflict means this delivery
 * has been seen, so two concurrent copies cannot both proceed.
 *
 * Not to be confused with `webhookDeliveries`, which records our OUTBOUND
 * deliveries to customer endpoints. Same word, opposite direction.
 *
 * Deployment-wide operational data with no tenant dimension, so no RLS (same
 * shape as `githubApp`). Rows are pruned past a retention window well beyond
 * GitHub's retry schedule; see `lib/github-delivery-dedup.ts`.
 */
export const githubWebhookDeliveries = pgTable(
  "github_webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("github_webhook_deliveries_received_at_idx").on(t.receivedAt)],
);

/**
 * A pending GitHub App install flow, created when an owner clicks "Connect
 * GitHub" and consumed by the OAuth identity callback that completes the bind.
 * This is the server-side source of truth tying the CSRF nonce, the Specboards
 * session, the workspace, and (after the setup callback) the returned
 * installation together; possession of the nonce alone never binds anything.
 * Rows are short-lived (expiresAt) and single-use. Flow state, not tenant
 * data: accessed only through the owner connection, like `github_app`.
 */
export const githubInstallStates = pgTable(
  "github_install_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Random one-time nonce round-tripped as OAuth/install `state`. */
    nonce: text("nonce").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The Specboards user who started the flow; only they may complete it.
     * No FK for the same reason as `members.user_id` (auth-disabled self-host).
     */
    userId: uuid("user_id").notNull(),
    /** Set by the setup callback once GitHub returns an installation id. */
    installationId: text("installation_id"),
    /** Account (org/user) the installation belongs to, per GitHub's API. */
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("github_install_states_expires_idx").on(t.expiresAt)],
);

/**
 * A GitHub App installation bound to a workspace, captured by the install
 * setup callback (CSRF-checked and verified against GitHub before insert).
 * Replaces the short-lived install cookie so the connect picker and repo
 * creation work whenever an admin visits, not just right after installing.
 * Removed when GitHub sends an `installation deleted` webhook.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    /** The org/user login the App is installed on, for display + repo creation. */
    accountLogin: text("account_login").notNull(),
    /** "Organization" or "User"; repo creation is org-only. */
    accountType: text("account_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("github_installations_ws_install_uq").on(
      t.workspaceId,
      t.installationId,
    ),
    index("github_installations_install_idx").on(t.installationId),
  ],
);

/** A connected GitHub repository (via the GitHub App installation). */
export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubInstallationId: text("github_installation_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /**
     * Marks the workspace's dedicated spec repository (created via the
     * one-click onboarding flow). Spec-seeding flows target it by default.
     */
    isSpecRepo: boolean("is_spec_repo").notNull().default(false),
    /** Parsed `.specboards/config.yml`, refreshed on sync. */
    config: jsonb("config"),
    /**
     * Admin-set write mode that wins over the repo config's `writeMode`, or
     * null for "whatever the repo says". Exists because a Specboard admin may
     * have no commit access to a connected repo's `.specboards/config.yml`,
     * and needing a pull request to change how pull requests are made is a bad
     * first day. Constrained to 'pr' | 'direct' in the migration.
     */
    writeModeOverride: text("write_mode_override"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("repositories_owner_name_uq").on(t.workspaceId, t.owner, t.name),
    // Target for composite FKs (product_repositories) scoping by tenant.
    unique("repositories_id_ws_uq").on(t.id, t.workspaceId),
  ],
);

/**
 * An explicit repo → product link. A repo can feed several products and a
 * product can be built from several repos (microservices); the row marked
 * `isDefault` names the product that sync assigns newly discovered specs to.
 * At most one default per repo (partial unique index, added by hand in the
 * migration — Drizzle can't express it), and the default is one of the linked
 * products by construction. A repo with no rows falls back to the workspace's
 * default product, which is also the pre-migration behavior (see backfill).
 */
export const productRepositories = pgTable(
  "product_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Sync assigns this repo's newly discovered specs to this product. */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("product_repositories_repo_product_uq").on(t.repoId, t.productId),
    index("product_repositories_repo_idx").on(t.repoId),
    index("product_repositories_product_idx").on(t.productId),
    foreignKey({
      columns: [t.repoId, t.workspaceId],
      foreignColumns: [repositories.id, repositories.workspaceId],
      name: "product_repositories_repo_ws_fk",
    }),
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "product_repositories_product_ws_fk",
    }),
  ],
);

/**
 * The metadata record for a spec. Linked to the git spec by `specId`
 * (matches the `id` frontmatter), NOT by path — so renames never orphan it.
 */
export const features = pgTable(
  "features",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Source repository, or NULL for DB-native items (initiatives/epics) that
     * live above the spec leaf and have no git backing. `set null` on delete so
     * disconnecting a repo detaches its imported items (they stay on the board
     * as standalone rows) rather than deleting the user's board content.
     */
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    /**
     * Owning product (sibling backlog). Nullable for legacy/unassigned rows;
     * the app always sets it on create. `restrict` on delete so a product with
     * items can't be removed out from under them (the service blocks it with a
     * friendly error, mirroring level deletion).
     */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "restrict",
    }),
    /**
     * Stable id, the public route + join key. For spec-backed rows it's the
     * spec's frontmatter `id`; for DB-native items (which have no spec) the app
     * sets it equal to the row `id`, so every row stays uniformly routable.
     */
    specId: uuid("spec_id").notNull(),
    /**
     * Hierarchy level key (composite FK to workspace_levels below). Spec-backed
     * rows are always the leaf level; DB-native rows take a higher level.
     */
    level: text("level").notNull().default("work"),
    /**
     * Stable grouping key for sync-created Feature groupings (the spec's
     * `feature` frontmatter or its folder path). Lets re-sync find the same
     * Feature instead of duplicating it. NULL for user-created rows. See ADR 0002.
     */
    externalKey: text("external_key"),
    title: text("title").notNull(),
    status: text("status").notNull().default("backlog"),
    assigneeId: uuid("assignee_id"),
    /**
     * Optional parent feature (an "epic" is just a feature with children).
     * `set null` on delete so removing a parent orphans children rather than
     * cascade-deleting their metadata.
     */
    parentId: uuid("parent_id").references((): AnyPgColumn => features.id, {
      onDelete: "set null",
    }),
    /**
     * Who set `parentId`: `'system'` when sync homed the item under a Feature
     * grouping, `'user'` when a person re-parented it in the app. NULL for a
     * row that has never had a parent. Re-sync only re-homes a `'system'` row,
     * so a manual re-parent survives a later `feature:` frontmatter change. See
     * gh-51 / RUNBOOK-github-sync.
     */
    parentSetBy: text("parent_set_by"),
    /**
     * The grouping key (`featureKeyFor(...)`) last used to home this spec row,
     * so re-sync can tell when a spec's `feature:` frontmatter changed. NULL
     * until sync records one. See gh-51.
     */
    syncedFeatureKey: text("synced_feature_key"),
    /**
     * Owning release, or null when unscheduled. `set null` on delete so
     * removing a release unschedules its items rather than deleting them.
     */
    releaseId: uuid("release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    /**
     * Owning cycle (sprint/iteration), or null when not in one. Orthogonal to
     * `release_id`: an item can be scheduled into both, and clearing one leaves
     * the other alone. `set null` on delete mirrors releases exactly, so
     * deleting a cycle unschedules its items and destroys no work.
     */
    cycleId: uuid("cycle_id").references(() => cycles.id, {
      onDelete: "set null",
    }),
    /** Fractional/lexical rank for manual backlog ordering. */
    rank: text("rank"),
    tags: text("tags").array().notNull().default([]),
    /** Values for admin-defined custom properties (see workspace_properties). */
    customFields: jsonb("custom_fields").notNull().default({}),
    /**
     * RICE prioritization inputs (all nullable until scored). The score itself
     * (Reach × Impact × Confidence/100 ÷ Effort) is computed in the app from
     * these, not stored, so it can't drift from its inputs. `float8`/`int`
     * (not numeric) so Drizzle hands back real numbers, not strings.
     */
    riceReach: doublePrecision("rice_reach"),
    /** Impact multiplier on the fixed RICE scale: 3, 2, 1, 0.5, or 0.25. */
    riceImpact: doublePrecision("rice_impact"),
    /** Confidence as a whole percentage, 0-100. */
    riceConfidence: integer("rice_confidence"),
    /** Effort in person-months (> 0). */
    riceEffort: doublePrecision("rice_effort"),
    /**
     * Markdown body for DB-native items (initiatives/epics), which have no
     * spec file. Spec-backed leaf items read their body from spec_index
     * instead; this stays null for them.
     */
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("features_repo_spec_uq").on(t.repoId, t.specId),
    index("features_workspace_status_idx").on(t.workspaceId, t.status),
    index("features_parent_idx").on(t.parentId),
    index("features_product_idx").on(t.productId),
    index("features_workspace_level_idx").on(t.workspaceId, t.level),
    index("features_external_key_idx").on(t.workspaceId, t.externalKey),
    index("features_release_idx").on(t.releaseId),
    index("features_cycle_idx").on(t.cycleId),
    foreignKey({
      columns: [t.workspaceId, t.level],
      foreignColumns: [workspaceLevels.workspaceId, workspaceLevels.key],
      name: "features_workspace_level_fk",
    }),
  ],
);

/**
 * An admin-defined custom item property (Settings -> Cards). `key` is the
 * stable slug values are stored under in `features.custom_fields`; `levels`
 * lists the hierarchy level keys the property applies to (null = every level).
 */
export const workspaceProperties = pgTable(
  "workspace_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Owning product, or NULL for the workspace default. Narrowing a
     * product's property set hides values without deleting them: an item's
     * `custom_fields` may hold keys the product no longer defines, and
     * re-adding the property brings them back. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** One of core PROPERTY_TYPES: text/number/select/multiselect/date/user. */
    type: text("type").notNull(),
    /** Which record the property is defined for: 'item' or 'release' (core
     * PROPERTY_ENTITIES). Keys are unique per (workspace, entity), so an item
     * and a release property can share a key. */
    entity: text("entity").notNull().default("item"),
    /** string[] of choices for select/multiselect. */
    options: jsonb("options").notNull().default([]),
    /** string[] of level keys the property applies to; null = all levels.
     * Always null for release-scoped properties (releases have no level). */
    levels: jsonb("levels"),
    /** Manual ordering in forms and settings; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Uniqueness is a pair of partial indexes (Drizzle can't express one);
    // see migration 0065.
    index("workspace_properties_ws_idx").on(t.workspaceId),
    index("workspace_properties_product_idx").on(t.productId),
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "workspace_properties_product_ws_fk",
    }),
  ],
);

/**
 * An admin-defined workflow stage (Settings -> Workflow). The ordered set of
 * stages a feature moves through on the board. `key` is the stable slug stored
 * in `features.status`; `label` is the editable display name (renaming a stage
 * changes only the label, so items keep their status). When a workspace has no
 * rows, the built-in default workflow applies. `archived` is a system status
 * and is not stored here.
 */
export const workspaceStatuses = pgTable(
  "workspace_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Owning product, or NULL for the workspace default every product
     * inherits. The unique keys are partial indexes (Drizzle can't express
     * one); see migration 0065. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** Manual ordering of stages (board column order); ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workspace_statuses_ws_idx").on(t.workspaceId),
    index("workspace_statuses_product_idx").on(t.productId),
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "workspace_statuses_product_ws_fk",
    }),
  ],
);

/**
 * A stage gate: one checklist item an admin attaches to a workflow stage
 * (`stage_key` references a `workspace_statuses.key`, or a built-in status key
 * when the workspace uses the default workflow). Exit-criteria semantics: an
 * item sitting in that stage must complete every gate before it can advance
 * forward. Workspace-scoped; ordered by `position` within a stage.
 */
export const workspaceStageGates = pgTable(
  "workspace_stage_gates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Owning product, or NULL for the workspace default. A gate always lives
     * beside the stage it guards: a product's gates reference that product's
     * stage keys. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    /** The stage this gate guards (a `workspace_statuses.key` or built-in key). */
    stageKey: text("stage_key").notNull(),
    label: text("label").notNull(),
    /** Manual ordering within a stage's checklist; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("workspace_stage_gates_ws_idx").on(t.workspaceId),
    index("workspace_stage_gates_ws_stage_idx").on(t.workspaceId, t.stageKey),
    index("workspace_stage_gates_product_idx").on(t.productId),
    foreignKey({
      columns: [t.productId, t.workspaceId],
      foreignColumns: [products.id, products.workspaceId],
      name: "workspace_stage_gates_product_ws_fk",
    }),
  ],
);

/**
 * A per-item record that one stage gate has been satisfied for one feature.
 * Presence of a row = that gate is checked off for that item. Absence = still
 * open. Feature-scoped completion state that gate enforcement reads.
 *
 * Extension path (not built yet): to support an admin-enabled "skip with
 * reason" flow, add nullable `skipped boolean` + `reason text` columns here and
 * treat a row as a resolution (completed OR skipped) rather than only a
 * completion. Future per-item-type gate bypass is enforced in the service
 * layer, not stored here.
 */
export const featureGateCompletions = pgTable(
  "feature_gate_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    gateId: uuid("gate_id")
      .notNull()
      .references(() => workspaceStageGates.id, { onDelete: "cascade" }),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The user who checked it off, for a future audit trail; null if unknown. */
    completedBy: uuid("completed_by"),
  },
  (t) => [
    unique("feature_gate_completions_uq").on(t.featureId, t.gateId),
    index("feature_gate_completions_feature_idx").on(t.featureId),
    index("feature_gate_completions_gate_idx").on(t.gateId),
  ],
);

/**
 * A release: a named ship vehicle items are scheduled into
 * (`features.release_id`). Drives the Roadmap grouping and the Backlog
 * release filter. Workspace-scoped (not per product) so a release can span
 * sibling backlogs.
 */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Product this release belongs to, or null for a workspace-wide
     * ("portfolio") release that spans every product. Product releases are
     * managed by that product's admins/contributors; portfolio releases are
     * owner-only. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    /** planned / in_progress / shipped. */
    status: text("status").notNull().default("planned"),
    /** Planned start date (date-only), or null when unset. */
    startDate: text("start_date"),
    /** Target ship date (date-only), or null when undated. */
    targetDate: text("target_date"),
    /** The date the release actually shipped (date-only), stamped when it first
     * transitions to `shipped` and cleared if it's reopened. Distinct from the
     * planned `targetDate`, which is retained. Null while unshipped. */
    shippedDate: text("shipped_date"),
    /** Free-form INTERNAL planning notes (Markdown), or null. Shown in the
     * release detail panel on the Roadmap. Distinct from the customer-facing
     * release notes below (`releaseNotes*`). */
    notes: text("notes"),
    /** Customer-facing release-notes surface, distinct from the internal
     * planning `notes`. `mode` selects between: `none` (no release notes),
     * `in_app` (Markdown authored in the app, stored in `releaseNotesBody`), and
     * `external` (a link to externally hosted notes in `releaseNotesUrl`). The
     * body and url are retained across mode switches so toggling back and forth
     * doesn't lose a draft. */
    releaseNotesMode: text("release_notes_mode").notNull().default("none"),
    releaseNotesBody: text("release_notes_body"),
    releaseNotesUrl: text("release_notes_url"),
    /** Values for admin-defined release-scoped custom properties (see
     * workspace_properties with entity='release'), keyed by property key.
     * Mirrors features.custom_fields. */
    customFields: jsonb("custom_fields").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Names are unique within a product, and independently within the
    // portfolio (null-product) scope, so two products can both have "v1.0".
    uniqueIndex("releases_product_name_uq")
      .on(t.productId, t.name)
      .where(sql`${t.productId} is not null`),
    uniqueIndex("releases_ws_portfolio_name_uq")
      .on(t.workspaceId, t.name)
      .where(sql`${t.productId} is null`),
    index("releases_ws_idx").on(t.workspaceId),
    index("releases_product_idx").on(t.productId),
  ],
);

/**
 * A cycle (sprint / iteration): a date-bounded time box a team works in
 * (`features.cycle_id`). Deliberately a *second, orthogonal axis* to releases,
 * not a flavour of one: an item can be in release v1.0 and in cycle "Sprint 14"
 * at the same time. A release is the customer-facing ship vehicle with an
 * explicit planned/in_progress/shipped lifecycle; a cycle is the team-facing
 * time box whose state is a function of today's date.
 *
 * There is deliberately **no status column**. A cycle is upcoming, active, or
 * complete purely from `start_date`/`end_date` against today, which avoids the
 * reopen/re-stamp problem `releases.shipped_date` needed migration 0043 to fix
 * and means a cycle can never be stale. See `core/cycles.ts`.
 */
export const cycles = pgTable(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Product this cycle belongs to, or null for a workspace-wide cycle
     * spanning every product. Mirrors the releases convention exactly: product
     * cycles are managed by that product's admins/contributors, workspace-wide
     * ones are owner-only. Cycles default to per-product in the UI. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    /** Inclusive first day of the cycle (date-only). */
    startDate: text("start_date").notNull(),
    /** Inclusive last day of the cycle (date-only); must be >= startDate. */
    endDate: text("end_date").notNull(),
    /** Free-form notes (Markdown), e.g. the cycle's goal. */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Names unique within a product, and independently within the
    // workspace-wide scope, so two products can both run "Sprint 1".
    uniqueIndex("cycles_product_name_uq")
      .on(t.productId, t.name)
      .where(sql`${t.productId} is not null`),
    uniqueIndex("cycles_ws_global_name_uq")
      .on(t.workspaceId, t.name)
      .where(sql`${t.productId} is null`),
    index("cycles_ws_idx").on(t.workspaceId),
    index("cycles_product_idx").on(t.productId),
    index("cycles_dates_idx").on(t.workspaceId, t.startDate, t.endDate),
  ],
);

/**
 * A goal (objective): a statement of intent with a measurable target and a
 * period. Deliberately NOT a hierarchy level, for two reasons that the
 * `features` table cannot satisfy: a goal is *measured* (a level is not), and
 * work laddering up to a goal is many-to-many and crosses products, while
 * `features.parent_id` is strictly single-parent and the roll-ups depend on
 * that. See the goal_links join table below.
 *
 * `parent_goal_id` gives goals their own shallow tree (a company objective
 * holding product objectives), separate from the item hierarchy.
 */
export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Product this goal belongs to, or null for an org-wide goal. Matches the
     * portfolio-release convention: product goals are managed by that product's
     * admins/contributors, org-wide ones are owner-only. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    /** Period the goal is measured over (date-only), or null when open-ended. */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    /** Optional parent goal, so a company objective can hold product ones.
     * `set null` on delete orphans children rather than cascading them away. */
    parentGoalId: uuid("parent_goal_id").references((): AnyPgColumn => goals.id, {
      onDelete: "set null",
    }),
    /** The owner's confidence call (see core GOAL_STATUSES). Distinct from
     * computed progress: progress is arithmetic, status is judgement. */
    status: text("status").notNull().default("on_track"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("goals_ws_idx").on(t.workspaceId),
    index("goals_product_idx").on(t.productId),
    index("goals_parent_idx").on(t.parentGoalId),
  ],
);

/**
 * A key result: one measurable outcome under a goal. Progress is **computed**
 * from start/current/target on read and never stored, following the RICE
 * precedent, so it cannot drift from its inputs.
 */
export const keyResults = pgTable(
  "key_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** number | percent | boolean (core METRIC_KINDS). */
    metricKind: text("metric_kind").notNull().default("number"),
    /** The baseline the measurement started from. */
    startValue: doublePrecision("start_value").notNull().default(0),
    /** The value that counts as done. */
    targetValue: doublePrecision("target_value").notNull(),
    /** Where it stands now; entered by a human in v1. */
    currentValue: doublePrecision("current_value").notNull().default(0),
    /** Manual ordering under the goal; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("key_results_goal_idx").on(t.goalId),
    index("key_results_ws_idx").on(t.workspaceId),
  ],
);

/**
 * Work laddering up to a goal: many-to-many, and reachable from ANY hierarchy
 * level, so an initiative and a single work item can both contribute. This is
 * the table that makes goals un-modellable as a hierarchy level: a feature can
 * serve several goals, and a goal can be served by work in several products,
 * neither of which the single-parent `features.parent_id` can express.
 *
 * Both sides cascade: deleting a feature removes its links and leaves the goal
 * intact (and vice versa).
 */
export const goalLinks = pgTable(
  "goal_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("goal_links_goal_feature_uq").on(t.goalId, t.featureId),
    index("goal_links_goal_idx").on(t.goalId),
    index("goal_links_feature_idx").on(t.featureId),
  ],
);

/**
 * An idea / feature request: lightweight demand capture that teams review and
 * either promote into a feature (`promotedFeatureId`) or park. Product-scoped
 * (a request targets one backlog) with the same visibility rules as features.
 * `status` moves through the idea review workflow (see core `ideas.ts`), which
 * is separate from the item/board workflow. `authorId` is the internal member
 * who captured it; the nullable `submitter*` columns hold an external portal
 * submitter's identity (public portal, a later phase) and stay null for
 * internally-captured ideas.
 */
export const ideas = pgTable(
  "ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * Owning product (sibling backlog). Nullable for unassigned rows; the app
     * resolves the default product on create. `set null` on delete so removing
     * a product detaches its ideas rather than deleting captured demand.
     */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    /** Free-form detail (Markdown), or null. */
    description: text("description"),
    /** Idea review stage key (see core DEFAULT_IDEA_STAGES). */
    status: text("status").notNull().default("new"),
    /** Internal member who captured the idea, or null (external submissions). */
    authorId: uuid("author_id"),
    /** External (portal) submitter's name; null for internal captures. */
    submitterName: text("submitter_name"),
    /** External (portal) submitter's email; null for internal captures. */
    submitterEmail: text("submitter_email"),
    /**
     * The feature this idea was promoted into, or null. `set null` on delete so
     * removing the feature reverts the idea to un-promoted rather than deleting
     * it.
     */
    promotedFeatureId: uuid("promoted_feature_id").references(
      () => features.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ideas_ws_idx").on(t.workspaceId),
    index("ideas_ws_status_idx").on(t.workspaceId, t.status),
    index("ideas_product_idx").on(t.productId),
  ],
);

/**
 * A vote on an idea (demand signal). One row per (idea, voter); the vote count
 * is derived by counting rows, mirroring how a release's item count is derived.
 * `userId` is an internal member for now; the public portal (a later phase)
 * will introduce an anonymous/external voter identity.
 */
export const ideaVotes = pgTable(
  "idea_votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => ideas.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("idea_votes_idea_user_uq").on(t.ideaId, t.userId),
    index("idea_votes_idea_idx").on(t.ideaId),
    index("idea_votes_ws_idx").on(t.workspaceId),
  ],
);

/**
 * An admin-defined idea review stage (Settings -> Ideas). The ordered set of
 * stages an idea moves through during triage. `key` is the stable slug stored
 * in `ideas.status`; `label` is the editable display name. When a workspace has
 * no rows, the built-in default idea workflow applies (see core `ideas.ts`).
 * Mirrors `workspace_statuses` for the item/board workflow.
 */
export const ideaStatuses = pgTable(
  "idea_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("idea_statuses_ws_key_uq").on(t.workspaceId, t.key),
    index("idea_statuses_ws_idx").on(t.workspaceId),
  ],
);

/**
 * Per-workspace Ideas configuration (Settings -> Ideas), one row per workspace.
 * Holds the public-portal settings; the portal itself (a public, unauthenticated
 * view of published ideas) is a later phase, but its config lives here so admins
 * can prepare it. Absent row = portal disabled with defaults.
 */
export const ideaSettings = pgTable("idea_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Whether the public voting portal is published. */
  portalEnabled: boolean("portal_enabled").notNull().default(false),
  /** Heading shown on the public portal, or null to use the workspace name. */
  portalTitle: text("portal_title"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Cached spec content + git pointers, kept in sync by the git service. */
export const specIndex = pgTable("spec_index", {
  featureId: uuid("feature_id")
    .primaryKey()
    .references(() => features.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  blobSha: text("blob_sha").notNull(),
  content: text("content").notNull(),
  /** Parsed structure: { title, sections: [...] }. */
  parsed: jsonb("parsed"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  featureId: uuid("feature_id")
    .notNull()
    .references(() => features.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A personal, in-app notification for one recipient — currently only
 * "@mention in a comment". Fanned out in the same transaction as the triggering
 * comment: one row per mentioned member. `readAt` null = unread, which drives
 * the inbox unread badge. `actorId` is a historical snapshot (no FK, like
 * `outbox_events`), so deleting the actor never rewrites someone's inbox; the
 * source `comment`/`feature` carry FKs so deleting an item clears its notices.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The mentioned user who should see this notification. */
    recipientId: uuid("recipient_id").notNull(),
    /** Who triggered it (comment author); snapshot, no FK. */
    actorId: uuid("actor_id"),
    /**
     * Kind of notification: "mention", or the outcome of a spec change the
     * recipient proposed ("spec_change_merged" / "spec_change_closed").
     */
    type: text("type").notNull().default("mention"),
    /** The item the comment lives on, for deep-linking the inbox row. */
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /**
     * The source comment; deleting it clears the notification. Null for a
     * notification that did not come from a comment, such as the outcome of a
     * review, rather than pointing at a placeholder nobody wrote.
     */
    commentId: uuid("comment_id").references(() => comments.id, {
      onDelete: "cascade",
    }),
    /** Short rendered preview of the comment for the inbox list. */
    snippet: text("snippet").notNull(),
    /** Null = unread; set when the recipient reads it. */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientId, t.readAt),
    index("notifications_comment_idx").on(t.commentId),
  ],
);

/**
 * A user's saved backlog filter ("custom view"): a named bundle of filter
 * params they can re-apply. Personal — scoped to the creating user within their
 * workspace, so each member curates their own list.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    name: text("name").notNull(),
    /** Which list the view applies to (currently always "backlog"). */
    view: text("view").notNull().default("backlog"),
    /** Serialized FeatureFilters (see apps/web feature-filters). */
    filters: jsonb("filters").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("saved_views_ws_user_idx").on(t.workspaceId, t.userId)],
);

/**
 * A user's personal board display preferences: which fields render on a card
 * and which custom field is "featured". Personal — scoped to the creating user
 * within their workspace, one row per (workspace, user, board). The `board`
 * discriminator lets each space (the Backlog and the Roadmap) keep its own
 * card-field selection; existing rows default to "backlog".
 */
export const boardPreferences = pgTable(
  "board_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    /** Which space these prefs belong to ("backlog" or "roadmap"). */
    board: text("board").notNull().default("backlog"),
    /** Ordered list of field keys to show on a card (see apps/web card-fields). */
    cardFields: jsonb("card_fields").notNull().default([]),
    /** Custom-field key to feature prominently, or null. */
    featured: text("featured"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("board_preferences_ws_user_board_uq").on(
      t.workspaceId,
      t.userId,
      t.board,
    ),
  ],
);

export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  featureId: uuid("feature_id").references(() => features.id, {
    onDelete: "cascade",
  }),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const featureLinkType = pgEnum("feature_link_type", [
  "blocks",
  "relates_to",
  "duplicates",
]);

/**
 * A directed, typed link between two features (dependencies & relations).
 * Stored canonically in ONE direction so the inverse is never double-entered:
 * `blocks` means `fromFeature` blocks `toFeature` (so `toFeature` is "blocked
 * by" `fromFeature`); `relates_to` is symmetric; `duplicates` means
 * `fromFeature` duplicates `toFeature`. The "blocked by" / "duplicated by"
 * views are derived by querying the `to_feature_id` side.
 */
export const featureLinks = pgTable(
  "feature_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromFeatureId: uuid("from_feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    toFeatureId: uuid("to_feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    type: featureLinkType("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("feature_links_uq").on(t.fromFeatureId, t.toFeatureId, t.type),
    index("feature_links_from_idx").on(t.fromFeatureId),
    index("feature_links_to_idx").on(t.toFeatureId),
  ],
);

export const githubLinkKind = pgEnum("github_link_kind", [
  "pull_request",
  "issue",
  "branch",
]);

/**
 * A link from a feature/work-item to a GitHub artifact (PR, issue, or branch).
 * Stored on the item it implements (the spec/leaf); the feature/epic above
 * rolls these up for display by walking `features.parent_id`. `featureId`
 * references any level, so the model is hierarchy-agnostic. `title`/`state` are
 * cached from GitHub on create and refreshed by the webhook.
 */
export const featureGithubLinks = pgTable(
  "feature_github_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: githubLinkKind("kind").notNull(),
    /** PR/issue number; null for a branch link. */
    number: integer("number"),
    /** Branch name; null for a PR/issue link. */
    branch: text("branch"),
    url: text("url").notNull(),
    /** Cached title from GitHub (refreshed by the webhook). */
    title: text("title"),
    /** Cached state: open / closed / merged; null for a branch. */
    state: text("state"),
    /**
     * Head branch of a pull request Specboards opened to propose a change to
     * this item's spec. Set only by the spec write path, so a non-null value is
     * what distinguishes "your change is waiting for review" from a pull request
     * someone linked to the card by hand.
     */
    headBranch: text("head_branch"),
    /**
     * When this link's state was last confirmed against GitHub. Stamped by the
     * webhook on every update, so the view-path reconcile only fires once the
     * webhook has stopped working. NULL means never confirmed.
     */
    stateCheckedAt: timestamp("state_checked_at", { withTimezone: true }),
    /**
     * Who proposed this change, for telling them what became of it. Snapshot
     * with no FK, like `notifications.actor_id`: a departed author's proposal
     * still has to render. Null for a link nobody opened through the app.
     */
    authorId: uuid("author_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("feature_github_links_uq").on(t.featureId, t.url),
    index("feature_github_links_feature_idx").on(t.featureId),
    index("feature_github_links_repo_kind_number_idx").on(
      t.repoId,
      t.kind,
      t.number,
    ),
  ],
);

/**
 * Per-user GitHub tokens, so a spec commit can genuinely be the author's
 * rather than the App's with their name in a trailer.
 *
 * These are GitHub App **user-to-server** tokens, not broad `repo`-scoped OAuth
 * app tokens: one can only reach repositories where the App is installed, and
 * only with the intersection of the App's permissions and the user's own. So a
 * connection grants Specboards nothing it did not already have; it narrows a
 * given write to what that person could do by hand.
 *
 * Both tokens are stored encrypted (see `lib/crypto`), because these are the
 * first credentials here that can write to a customer's repository and a
 * database disclosure alone must not yield a usable one.
 */
export const githubUserTokens = pgTable(
  "github_user_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Whose account it is, so the UI can say so without an API call. */
    githubLogin: text("github_login").notNull(),
    /** AES-256-GCM blob, never the raw token. */
    accessToken: text("access_token").notNull(),
    /** AES-256-GCM blob. Null when the App does not expire user tokens. */
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("github_user_tokens_ws_user_uq").on(t.workspaceId, t.userId)],
);

/**
 * Every attempt to write a spec, recorded in the product rather than only in
 * git.
 *
 * Git has no record of a commit that never happened, which is exactly the case
 * someone is investigating when they ask why a change they remember making is
 * not there. So refusals and failures are recorded as deliberately as successes,
 * with `detail` carrying the reason in the words the author was shown.
 *
 * `attribution` records whether the change was committed as the author, credited
 * through a co-author trailer, or attributed to nobody. Without it, a history
 * full of app-authored commits cannot be told apart from one where attribution
 * silently stopped working.
 *
 * No FK on `actorId`: an audit row must outlive the account it names.
 */
export const specWriteAudit = pgTable(
  "spec_write_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id"),
    /** Display name snapshotted at write time, like the change ledger's. */
    actorLabel: text("actor_label"),
    specId: uuid("spec_id"),
    repoId: uuid("repo_id"),
    path: text("path").notNull(),
    /** create | update | remove */
    action: text("action").notNull(),
    /** pr | direct; null when the write never got as far as choosing. */
    mode: text("mode"),
    /** committed | proposed | refused | failed */
    outcome: text("outcome").notNull(),
    /** author | co_author | none */
    attribution: text("attribution").notNull(),
    commitSha: text("commit_sha"),
    pullRequestNumber: integer("pull_request_number"),
    /** Why, for a refusal or failure; the message the author was shown. */
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("spec_write_audit_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("spec_write_audit_spec_idx").on(t.specId),
  ],
);

/**
 * Auth tables (Better Auth). Postgres mints UUID ids (Better Auth runs with
 * `generateId: false`) so they line up with the existing uuid user references
 * (`members.user_id`, `comments.author_id`, `features.assignee_id`).
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** IANA time zone (e.g. "America/Los_Angeles"); set on Settings → Profile. */
  timezone: text("timezone"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Credential or OAuth provider link (email/password hashes live here). */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * OAuth clients registered against the MCP OAuth provider (Better Auth `mcp`
 * plugin, model `oauthApplication`). Rows are created by Dynamic Client
 * Registration (RFC 7591) when an MCP client (Claude Code, claude.ai, …)
 * connects for the first time; `clientId` is the public identifier the
 * authorize/token endpoints key on. `redirectUrls` is a comma-joined list and
 * `metadata` a JSON string because that is the shape the plugin reads back.
 * Like the other auth tables: user-scoped, no workspaceId, no RLS.
 */
export const oauthApplications = pgTable(
  "oauth_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Client display name from DCR (`client_name`); optional in the RFC. */
    name: text("name"),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").notNull().unique(),
    /** Empty for `public` (PKCE-only) clients; the plugin stores "" not NULL. */
    clientSecret: text("client_secret"),
    redirectUrls: text("redirect_urls").notNull(),
    /** "web" (confidential) or "public" (native/PKCE-only). */
    type: text("type").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    /** Registering user when DCR happened with a session; else anonymous. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("oauth_applications_user_idx").on(table.userId)],
);

/**
 * Access + refresh token pairs minted by the MCP OAuth token endpoint (model
 * `oauthAccessToken`). The MCP endpoint validates `Authorization: Bearer`
 * values against `accessToken` here (opaque tokens, not JWTs) and acts as
 * `userId`, inheriting their workspace membership and role exactly like an
 * `sb_` API key does.
 */
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessToken: text("access_token").notNull().unique(),
    refreshToken: text("refresh_token").notNull().unique(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("oauth_access_tokens_client_idx").on(table.clientId),
    index("oauth_access_tokens_user_idx").on(table.userId),
  ],
);

/**
 * Record of a user approving an OAuth client on the consent screen (model
 * `oauthConsent`). Every authorize request is forced through consent (see
 * auth.ts), so this is an audit trail of which clients a user has approved.
 */
export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    consentGiven: boolean("consent_given").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("oauth_consents_client_idx").on(table.clientId),
    index("oauth_consents_user_idx").on(table.userId),
  ],
);

/**
 * The workspace an MCP OAuth connection acts in, chosen on the consent screen.
 * Keyed by (userId, clientId): one connection of a given OAuth client for a
 * given user targets exactly one workspace. The `/api/mcp` resolver reads this
 * when the request carries no explicit `x-org-slug` header, so a multi-org user
 * who picked a workspace at consent time never has to configure a header. The
 * header still wins when present, so a single client can be pointed at two
 * workspaces from two configs if needed. Membership is re-validated on every
 * request, so a stale binding to a workspace the user has left resolves to no
 * access rather than silently granting it.
 */
export const mcpWorkspaceBindings = pgTable(
  "mcp_workspace_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplications.clientId, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The Specboards scopes this connection was granted at consent time.
     *
     * NULL means no grant was ever recorded, which is every connection made
     * before consent asked the question. Those keep their existing behaviour
     * (the full access of the authorizing user) rather than breaking mid-flight;
     * `[]` would mean the same thing to `keyScopesSatisfy` but by accident, so
     * the two are kept distinct: NULL is "never asked", `[]` is unreachable.
     *
     * Better Auth's own `scopes` are the OIDC set (openid/profile/email/
     * offline_access) and cannot carry an application grant, so this is stored
     * alongside the workspace choice the consent screen already records.
     */
    scopes: text("scopes").array(),
    /**
     * Whether the connection may call the tools that destroy data
     * (`McpTool.destructive`). Separate from `scopes` because it cannot be
     * expressed as one: `delete_item` and `update_item` both require
     * `features:write`, so no resource scope distinguishes them.
     */
    allowDestructive: boolean("allow_destructive").notNull().default(false),
    /** Last time this connection authenticated a call, for the settings list. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("mcp_workspace_bindings_user_client_key").on(
      table.userId,
      table.clientId,
    ),
    index("mcp_workspace_bindings_workspace_idx").on(table.workspaceId),
  ],
);

/**
 * Personal API keys for programmatic access (the CLI). We only ever store the
 * SHA-256 `keyHash`; the plaintext key is shown once at creation. `prefix` is
 * the leading, non-secret slice kept for display ("sb_live_a1b2c3…"). Scoped to
 * a user (the key acts as that user, inheriting their workspace membership and
 * role), so no workspaceId and no RLS, mirroring the other auth tables.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    /**
     * Resource scopes granted to this key, each `"<resource>:<read|write>"`
     * (or `"*"` for full access). An EMPTY array means a legacy full-user key
     * (created before scopes existed), so back-compat is preserved: existing
     * keys keep unrestricted access. A non-empty array restricts the key to
     * exactly those scopes (see `api-scopes.ts`).
     */
    scopes: text("scopes").array().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("api_keys_user_idx").on(table.userId)],
);

/**
 * A registered outbound-webhook endpoint. Workspace-scoped and admin-managed
 * (mirrors releases/ideas). `secret` is the HMAC signing key, stored
 * `encryptSecret`'d (reused to sign every delivery, so encrypted not hashed) and
 * shown to the admin exactly once at creation. `productId` is the per-product
 * routing filter: null means every product's events in the workspace, a value
 * means only that product's (plus workspace-level events). `eventTypes` is the
 * subscription set; an event whose `type` isn't listed is never delivered.
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Per-product routing filter; null = all products. `set null` on delete so
     * removing a product widens the endpoint to workspace-wide rather than
     * silently dropping it. */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** Delivery target; https only, SSRF-validated on write. */
    url: text("url").notNull(),
    /** `encryptSecret`'d HMAC signing key. */
    secret: text("secret").notNull(),
    /** Subscribed event type keys, e.g. {item.status_changed, release.shipped}. */
    eventTypes: text("event_types").array().notNull().default([]),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    /** Count of consecutive failed deliveries; reset on any success or manual
     * resume. When it crosses the disable threshold the endpoint is set
     * `active = false` (auto-disabled) so a dead endpoint stops eating retries. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("webhook_endpoints_ws_idx").on(t.workspaceId),
    index("webhook_endpoints_product_idx").on(t.productId),
  ],
);

/**
 * The transactional-outbox row for one (event, endpoint) delivery. Written
 * `pending` right after the domain change; an in-process drainer claims due rows
 * (`FOR UPDATE SKIP LOCKED`), POSTs the signed payload, and records
 * `delivered|failed` with exponential backoff via `attempts`/`nextAttemptAt`.
 * `payload` is the frozen envelope so a redeliver re-sends the exact bytes.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The envelope id (also the `X-Specboards-Delivery` header), for consumer dedupe. */
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    /** pending | delivered | failed. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** When this row is next eligible to send; null once delivered/failed. */
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).defaultNow(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_due_idx").on(t.nextAttemptAt),
    index("webhook_deliveries_endpoint_idx").on(t.endpointId),
  ],
);

/**
 * Transactional outbox. Every domain change that should notify consumers writes
 * one row here *in the same transaction* as the change (see the store's mutating
 * methods), so an event can never be lost in the gap between a commit and a
 * separate enqueue. A relay claims unprocessed rows, fans each out to matching
 * webhook endpoints (creating `webhook_deliveries`), and stamps `processedAt`.
 * `data` is an opaque snapshot the relay maps to a consumer format. Generic on
 * purpose: future consumers (in-app notifications, activity feed) read the same
 * stream. `productId`/`actorId` are historical snapshots (no FK), so deleting a
 * product or user never rewrites past events.
 */
/**
 * The item change ledger: who changed what, when, and what it was before.
 *
 * Distinct from {@link outboxEvents}, which is a delivery queue: that one has
 * mutable processing state and is prunable once delivered, while this is
 * immutable and must outlive any delivery schedule. Rows are appended in the
 * same transaction as the change that produced them (the pattern `writeOutbox`
 * established), so a change can never exist without its record.
 *
 * Append-only, enforced by a database trigger. A revert is a new forward event,
 * never an edit of the row it undoes.
 *
 * Item identity is snapshotted and carries no foreign key on purpose: an audit
 * trail that erases itself when the item is deleted cannot answer "who deleted
 * this, and what was it". Spec **content** is deliberately absent; git is
 * canonical for that, and spec events point at `commitSha` instead.
 */
export const itemEvents = pgTable(
  "item_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Snapshot; no FK, so history survives the item's deletion. */
    featureId: uuid("feature_id"),
    /** The item's stable public id, snapshotted. */
    specId: uuid("spec_id"),
    /** The item's title when the change happened. */
    itemTitle: text("item_title"),
    /** Product scope at the time of the change; null = no product. */
    productId: uuid("product_id"),
    /** user | api_key | agent | sync | system (checked in the database). */
    actorType: text("actor_type").notNull(),
    /** The user the action ran as, including an API key's owner. */
    actorId: uuid("actor_id"),
    /** Display name at the time, so a renamed or deleted user stays readable. */
    actorLabel: text("actor_label"),
    type: text("type").notNull(),
    /** The column that changed, for a field change. */
    field: text("field"),
    before: jsonb("before"),
    after: jsonb("after"),
    /** Event-specific detail that is not a field change. */
    data: jsonb("data"),
    /** For spec-content events: the commit the change landed in. */
    commitSha: text("commit_sha"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("item_events_item_idx").on(t.workspaceId, t.featureId, t.createdAt),
    index("item_events_ws_created_idx").on(t.workspaceId, t.createdAt),
    index("item_events_actor_idx").on(t.workspaceId, t.actorId, t.createdAt),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Routing scope snapshot; null = workspace-level event (no product). */
    productId: uuid("product_id"),
    /** The acting user at the time of the event, or null (system/unattributable). */
    actorId: uuid("actor_id"),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the relay finished fanning this event out; null = still pending. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_events_ws_idx").on(t.workspaceId),
    index("outbox_events_created_idx").on(t.createdAt),
  ],
);

/**
 * Where a product keeps the docs for one Plan-section area ("strategy",
 * "research", or "architecture"): one row per (product, area). `mode` is the
 * team's choice for that area: `local` (pages live in Specboards, see
 * `doc_pages`), `external` (an outside repository like SharePoint or Box that
 * we only link out to via `externalUrl`), or `github` (a GitHub repo of
 * Markdown files, `repoId`; edit-and-commit is a later slice). Absent row =
 * the team hasn't chosen yet (the area shows the setup chooser). Strategy
 * skips the chooser and is always `local`.
 */
export const docSpaces = pgTable(
  "doc_spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Plan-section area key: strategy / research / architecture. */
    area: text("area").notNull(),
    /** Source choice: local / external / github. */
    mode: text("mode").notNull(),
    /** Link-out URL for `external` mode, else null. */
    externalUrl: text("external_url"),
    /** Backing repo for `github` mode, else null. */
    repoId: uuid("repo_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("doc_spaces_product_area_uq").on(t.productId, t.area),
    index("doc_spaces_ws_idx").on(t.workspaceId),
  ],
);

/**
 * A folder or Markdown page in a locally-held doc space (doc_spaces mode
 * `local`; also Strategy, which is always local). Pages form a tree via
 * `parentId` (a folder row); deleting a folder cascades to its contents.
 * `content` is Markdown, edited with the rich-text editor and empty for
 * folders. Ordered by `position` within a parent, then title.
 */
export const docPages = pgTable(
  "doc_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Plan-section area key: strategy / research / architecture. */
    area: text("area").notNull(),
    /** Containing folder, or null at the area root. */
    parentId: uuid("parent_id").references((): AnyPgColumn => docPages.id, {
      onDelete: "cascade",
    }),
    /** Row kind: folder / page. */
    kind: text("kind").notNull().default("page"),
    title: text("title").notNull(),
    /** Markdown body (empty for folders). */
    content: text("content").notNull().default(""),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("doc_pages_product_area_idx").on(t.productId, t.area),
    index("doc_pages_ws_idx").on(t.workspaceId),
    index("doc_pages_parent_idx").on(t.parentId),
  ],
);

/**
 * A workspace's inference credential, held apart from the provider row that
 * uses it (see {@link modelProviders}).
 *
 * The separation is deliberate: rotation wants to write a new secret before
 * retiring the old one, and RLS is row-level, so keeping the secret in its own
 * table is the only way to let a member resolve the endpoint while the material
 * stays owner-only. `secret` is an `encryptSecret` blob and never leaves the
 * server; `hint` is the last few characters, stored so the settings page can
 * label a key without decrypting anything.
 */
export const modelProviderCredentials = pgTable(
  "model_provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** AES-256-GCM blob from `encryptSecret`. Never sent to the browser. */
    secret: text("secret").notNull(),
    /** Last few characters only, e.g. "a91c", for a masked display hint. */
    hint: text("hint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("model_provider_credentials_ws_idx").on(t.workspaceId),
    // Backs the composite FK from `model_providers`, which is what stops a
    // provider row pointing at another workspace's credential.
    unique("model_provider_credentials_id_ws_uq").on(t.id, t.workspaceId),
  ],
);

/**
 * The model connection a workspace brings itself: one row per workspace, unique
 * so resolution never has to pick a winner.
 *
 * `kind` records the wire protocol rather than the vendor. Only
 * `openai_compatible` exists today, which covers the hosted providers worth
 * naming as well as vLLM, Ollama and the gateways on-prem customers run, so a
 * native per-vendor adapter stays an additive change.
 *
 * `credentialId` is nullable because a locally hosted endpoint commonly wants
 * no key at all; that is a real state, not a missing value.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Wire protocol. Constrained to `openai_compatible` by a CHECK. */
    kind: text("kind").notNull().default("openai_compatible"),
    /** Endpoint root, e.g. https://api.openai.com/v1. Egress-checked on write
     * and again before every call, so tightening the policy takes effect on
     * rows written while it was looser. */
    baseUrl: text("base_url").notNull(),
    /** Passed to the endpoint verbatim; we keep no model catalogue. */
    model: text("model").notNull(),
    /** FK declared once, as the composite below: it is strictly stronger than
     * a plain reference to `id`, so a second overlapping constraint would only
     * be one more thing to keep in step. */
    credentialId: uuid("credential_id"),
    enabled: boolean("enabled").notNull().default(true),
    /** Set on each successful completion, so a live connection is
     * distinguishable from one configured and never exercised. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("model_providers_ws_uq").on(t.workspaceId),
    // NOTE: migration 0067 declares this as `ON DELETE SET NULL ("credential_id")`.
    // The column list matters (without it Postgres also nulls `workspace_id`,
    // which is NOT NULL, making credential deletion impossible) and Drizzle has
    // no way to express it, so the SQL is authoritative here. Migrations in this
    // repo are hand-written, so nothing regenerates this into a mismatch.
    foreignKey({
      columns: [t.credentialId, t.workspaceId],
      foreignColumns: [
        modelProviderCredentials.id,
        modelProviderCredentials.workspaceId,
      ],
      name: "model_providers_credential_ws_fk",
    }).onDelete("set null"),
  ],
);

/**
 * One turn in the assistant conversation about an item.
 *
 * There is no `assistant_conversations` parent: an item holds exactly one
 * thread, because the point of persisting it is that a colleague opening the
 * card can see how the definition was arrived at, and several threads means
 * they see one of them without being able to tell whether it is the one that
 * mattered. Migration 0068 explains what adding a parent would take.
 *
 * `system` is not a storable role. The system prompt is rebuilt from the item
 * on every request (`lib/ai/item-context.ts`) so a thread started before a
 * prompt change does not keep replaying the old one.
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The item this thread belongs to. Cascades, so deleting an item takes
     * its conversation with it rather than leaving a copy of its content. */
    featureId: uuid("feature_id")
      .notNull()
      .references(() => features.id, { onDelete: "cascade" }),
    /** `user` or `assistant`, constrained by a CHECK. */
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** The human this turn belongs to: who typed it, or who asked for it.
     * Snapshot with no FK, like `notifications.actorId`. */
    authorId: uuid("author_id").notNull(),
    /** What the endpoint said answered; null on a user turn. */
    model: text("model"),
    /** As reported by the endpoint. Null means it reported nothing, which is
     * not zero and must not be summed as if it were. */
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    /**
     * What happened to the proposed edit this turn carried: `accepted`,
     * `rejected`, or null for unresolved. Whether there *is* a proposal is
     * decided by parsing `content`, never by this column, so the two can never
     * disagree about it.
     */
    proposalOutcome: text("proposal_outcome"),
    proposalResolvedBy: uuid("proposal_resolved_by"),
    proposalResolvedAt: timestamp("proposal_resolved_at", { withTimezone: true }),
    /** Commit an accepted proposal landed in, for a git-backed spec. */
    proposalCommitSha: text("proposal_commit_sha"),
    /**
     * Blob sha of the description the proposal was drafted against, so
     * accepting takes the same guarded, merged path a human save takes rather
     * than overwriting whatever landed in the meantime. Null for a DB-native
     * card, which has no blob.
     */
    proposalBaseSha: text("proposal_base_sha"),
    /**
     * The skill that was in force for this turn (a
     * `workspace_assistant_skills.key` or a built-in key), or null for an
     * ordinary typed question. Recorded rather than recomputed: skills get
     * reworded, and a thread that was a grilling has to still read as one
     * afterwards. A key that no longer resolves is treated as null.
     */
    skillKey: text("skill_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("assistant_messages_feature_idx").on(
      t.workspaceId,
      t.featureId,
      t.createdAt,
    ),
  ],
);

/**
 * A skill: standing instructions a team gives their assistant, shown as a button
 * on every item ("Grill me", "Find the gaps").
 *
 * Holds only what a workspace has *changed*. The starting set lives in code
 * (`apps/web/src/lib/ai/skills.ts`), so a fresh install has it with no seeding;
 * a row whose `key` matches a built-in overrides that built-in wholesale, and
 * any other key is a skill of the team's own. A workspace with no rows keeps
 * tracking the code as those prompts improve.
 *
 * Read by every member (they see the buttons), written by org admins only: a
 * skill is attached to every future question anyone asks and to every edit
 * proposed off the back of one.
 */
export const workspaceAssistantSkills = pgTable(
  "workspace_assistant_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stable identifier; what makes an override an override. Never re-derived
     * from the name, which a rename would otherwise silently orphan. */
    key: text("key").notNull(),
    /**
     * Null means "whatever the built-in says", which is what a position-only row
     * stores. That is what lets a workspace reorder the buttons without pinning
     * the prompts to the wording they had that day; see migration 0071. Null is
     * meaningless on a skill the team invented, and the service refuses it there.
     */
    name: text("name"),
    /** One line under the button. Never sent to the model. */
    description: text("description"),
    instructions: text("instructions"),
    /** False hides it from the panel without losing the wording. */
    enabled: boolean("enabled").notNull().default(true),
    /** Where this skill sits in the row of buttons, ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_assistant_skills_key_idx").on(t.workspaceId, t.key),
  ],
);

/**
 * One call to a model, and what it cost.
 *
 * The ledger behind usage accounting: a row per call through
 * `model-provider-service.ts`, whatever triggered it and however it ended. A
 * running counter would be cheaper and cannot answer the question that actually
 * gets asked, which is "what is this charge on my provider bill" (see migration
 * 0074).
 *
 * Append-only: RLS grants SELECT and INSERT and declares no UPDATE or DELETE
 * policy, so nothing in the app can rewrite what was spent.
 */
export const modelUsageEvents = pgTable(
  "model_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Who it was spent on behalf of. Snapshot with no FK, like
     * `assistantMessages.authorId`: deactivating someone must not rewrite the
     * record a billing dispute turns on. */
    userId: uuid("user_id").notNull(),
    /** What triggered it: see `UsageFeature` in `lib/usage-service.ts`. */
    feature: text("feature").notNull(),
    /** What the endpoint said answered. Null when nothing did. */
    model: text("model"),
    /** As reported by the endpoint. Null means unmeasured, not free. */
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    /** `ok`, `error`, or `cancelled`, constrained by a CHECK. */
    outcome: text("outcome").notNull(),
    /** The adapter's `ModelErrorKind`, when `outcome` is `error`. */
    errorKind: text("error_kind"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("model_usage_events_ws_time_idx").on(t.workspaceId, t.createdAt),
    index("model_usage_events_ws_user_time_idx").on(
      t.workspaceId,
      t.userId,
      t.createdAt,
    ),
  ],
);

/**
 * What a workspace is allowed to spend through Specboards.
 *
 * Its own table rather than columns on {@link modelProviders}, even though both
 * are one row per workspace, because deleting the provider is how you change
 * endpoints: a cap living there would vanish on a reconnection and nobody would
 * be told. Null means uncapped, which is not the same as zero ("stop
 * entirely"); a workspace with no row has never set one.
 */
export const workspaceUsageLimits = pgTable("workspace_usage_limits", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Prompt + completion tokens allowed in a calendar month. Null is uncapped. */
  monthlyTokenCap: integer("monthly_token_cap"),
  /** Tokens one person may spend in a day. Null is uncapped. */
  dailyUserTokenCap: integer("daily_user_token_cap"),
  /** Who last changed it; a cap raised before a large bill gets looked up. */
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  members: many(members),
  repositories: many(repositories),
  features: many(features),
  levels: many(workspaceLevels),
  products: many(products),
}));

export const productRelations = relations(products, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [products.workspaceId],
    references: [workspaces.id],
  }),
  members: many(productMembers),
  features: many(features),
}));

export const productMemberRelations = relations(productMembers, ({ one }) => ({
  product: one(products, {
    fields: [productMembers.productId],
    references: [products.id],
  }),
}));

export const repositoryRelations = relations(repositories, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [repositories.workspaceId],
    references: [workspaces.id],
  }),
  features: many(features),
}));

export const ideaRelations = relations(ideas, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [ideas.workspaceId],
    references: [workspaces.id],
  }),
  product: one(products, {
    fields: [ideas.productId],
    references: [products.id],
  }),
  promotedFeature: one(features, {
    fields: [ideas.promotedFeatureId],
    references: [features.id],
  }),
  votes: many(ideaVotes),
}));

export const ideaVoteRelations = relations(ideaVotes, ({ one }) => ({
  idea: one(ideas, {
    fields: [ideaVotes.ideaId],
    references: [ideas.id],
  }),
}));

export const featureRelations = relations(features, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [features.workspaceId],
    references: [workspaces.id],
  }),
  repository: one(repositories, {
    fields: [features.repoId],
    references: [repositories.id],
  }),
  product: one(products, {
    fields: [features.productId],
    references: [products.id],
  }),
  index: one(specIndex, {
    fields: [features.id],
    references: [specIndex.featureId],
  }),
  comments: many(comments),
}));
