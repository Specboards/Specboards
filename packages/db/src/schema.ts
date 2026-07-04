import { relations } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Specboard data model. Spec *content* is canonical in git; this DB holds the
 * *metadata* (status/assignment/priority/ordering) plus a cached index of spec
 * content for fast boards and querying. Every tenant-scoped row carries
 * `workspaceId` so Postgres RLS can isolate tenants (see migrations).
 */

export const memberRole = pgEnum("member_role", ["admin", "pm", "ux", "eng", "viewer"]);

/** A product's read visibility: `org` (every member can read) or `private`
 * (read requires org-admin or explicit product membership). */
export const productVisibility = pgEnum("product_visibility", ["org", "private"]);

/** A user's role on a single product: `admin` (manage product + members + edit
 * items), `editor` (edit items), `viewer` (read — only meaningful for private
 * products, where it grants access). */
export const productMemberRole = pgEnum("product_member_role", ["admin", "editor", "viewer"]);

/** Tenant root. SaaS has many; a self-host install typically has one. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    name: text("name").notNull(),
    /** Markdown body used as the starting point for a card's details. */
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("detail_templates_ws_name_uq").on(t.workspaceId, t.name),
    index("detail_templates_ws_idx").on(t.workspaceId),
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
    /** Manual ordering in the product switcher; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("products_ws_key_uq").on(t.workspaceId, t.key),
    index("products_ws_idx").on(t.workspaceId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("product_members_product_user_uq").on(t.productId, t.userId),
    index("product_members_product_idx").on(t.productId),
    index("product_members_user_idx").on(t.userId),
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
    role: memberRole("role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("members_workspace_user_uq").on(t.workspaceId, t.userId)],
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
  /** PEM, encrypted at rest (AES-256-GCM keyed off BETTER_AUTH_SECRET). */
  privateKey: text("private_key").notNull(),
  /** Webhook signing secret, encrypted at rest. */
  webhookSecret: text("webhook_secret").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("github_installations_ws_install_uq").on(t.workspaceId, t.installationId),
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
    /** Parsed `.specboard/config.yml`, refreshed on sync. */
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("repositories_owner_name_uq").on(t.workspaceId, t.owner, t.name)],
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
     * Owning release, or null when unscheduled. `set null` on delete so
     * removing a release unschedules its items rather than deleting them.
     */
    releaseId: uuid("release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    /** Fractional/lexical rank for manual backlog ordering. */
    rank: text("rank"),
    tags: text("tags").array().notNull().default([]),
    /** Values for admin-defined custom properties (see workspace_properties). */
    customFields: jsonb("custom_fields").notNull().default({}),
    /**
     * Markdown body for DB-native items (initiatives/epics), which have no
     * spec file. Spec-backed leaf items read their body from spec_index
     * instead; this stays null for them.
     */
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("features_repo_spec_uq").on(t.repoId, t.specId),
    index("features_workspace_status_idx").on(t.workspaceId, t.status),
    index("features_parent_idx").on(t.parentId),
    index("features_product_idx").on(t.productId),
    index("features_workspace_level_idx").on(t.workspaceId, t.level),
    index("features_external_key_idx").on(t.workspaceId, t.externalKey),
    index("features_release_idx").on(t.releaseId),
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
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** One of core PROPERTY_TYPES: text/number/select/multiselect/date/user. */
    type: text("type").notNull(),
    /** string[] of choices for select/multiselect. */
    options: jsonb("options").notNull().default([]),
    /** string[] of level keys the property applies to; null = all levels. */
    levels: jsonb("levels"),
    /** Manual ordering in forms and settings; ascending. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspace_properties_ws_key_uq").on(t.workspaceId, t.key),
    index("workspace_properties_ws_idx").on(t.workspaceId),
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
    name: text("name").notNull(),
    /** planned / in_progress / shipped. */
    status: text("status").notNull().default("planned"),
    /** Planned start date (date-only), or null when unset. */
    startDate: text("start_date"),
    /** Target ship date (date-only), or null when undated. */
    targetDate: text("target_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("releases_ws_name_uq").on(t.workspaceId, t.name),
    index("releases_ws_idx").on(t.workspaceId),
  ],
);

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
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_views_ws_user_idx").on(t.workspaceId, t.userId)],
);

/**
 * A user's personal board display preferences: which fields render on a card
 * and which custom field is "featured". Personal — scoped to the creating user
 * within their workspace, one row per (workspace, user).
 */
export const boardPreferences = pgTable(
  "board_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    /** Ordered list of field keys to show on a card (see apps/web card-fields). */
    cardFields: jsonb("card_fields").notNull().default([]),
    /** Custom-field key to feature prominently, or null. */
    featured: text("featured"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("board_preferences_ws_user_uq").on(t.workspaceId, t.userId)],
);

export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  featureId: uuid("feature_id").references(() => features.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id"),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("api_keys_user_idx").on(table.userId)],
);

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
