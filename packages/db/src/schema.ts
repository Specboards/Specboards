import { relations } from "drizzle-orm";
import {
  boolean,
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
 * SpecBoard data model. Spec *content* is canonical in git; this DB holds the
 * *metadata* (status/assignment/priority/ordering) plus a cached index of spec
 * content for fast boards and querying. Every tenant-scoped row carries
 * `workspaceId` so Postgres RLS can isolate tenants (see migrations).
 */

export const memberRole = pgEnum("member_role", ["admin", "pm", "ux", "eng", "viewer"]);

/** Tenant root. SaaS has many; a self-host install typically has one. */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Stable id from the spec's frontmatter; the git<->DB join key. */
    specId: uuid("spec_id").notNull(),
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
    priority: integer("priority"),
    /** Effort estimate in points (validated against RepoConfig.estimate.scale). */
    estimate: integer("estimate"),
    /** Fractional/lexical rank for manual backlog ordering. */
    rank: text("rank"),
    tags: text("tags").array().notNull().default([]),
    roadmapQuarter: text("roadmap_quarter"),
    /** Values for team-defined custom fields (see RepoConfig.fields). */
    customFields: jsonb("custom_fields").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("features_repo_spec_uq").on(t.repoId, t.specId),
    index("features_workspace_status_idx").on(t.workspaceId, t.status),
    index("features_parent_idx").on(t.parentId),
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

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  members: many(members),
  repositories: many(repositories),
  features: many(features),
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
  index: one(specIndex, {
    fields: [features.id],
    references: [specIndex.featureId],
  }),
  comments: many(comments),
}));
