/**
 * A hand-authored OpenAPI 3.0 description of the public `/api/v1` surface,
 * served at `GET /api/v1/openapi.json`. This is the living spec: it covers the
 * core resources external clients use (the CLI exercises a subset). When you
 * add or change a public route, update this document and `api-client.ts`
 * together.
 *
 * It intentionally documents the primary resources and verbs rather than every
 * one of the ~70 internal routes; the depth here is the contract we support for
 * programmatic use.
 */

const paginationParams = [
  {
    name: "limit",
    in: "query",
    required: false,
    description:
      "Opt-in page size (1-200). Omit for the full list. When present the response gains a `nextCursor` field.",
    schema: { type: "integer", minimum: 1, maximum: 200 },
  },
  {
    name: "cursor",
    in: "query",
    required: false,
    description: "Opaque cursor from a previous response's `nextCursor`.",
    schema: { type: "string" },
  },
] as const;

/** A GET list operation with opt-in pagination on a named collection. */
function listOp(tag: string, key: string, summary: string) {
  return {
    tags: [tag],
    summary,
    parameters: [...paginationParams],
    responses: {
      "200": {
        description: "The collection (plus `nextCursor` when `limit` was given).",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                [key]: { type: "array", items: { type: "object" } },
                nextCursor: { type: "string", nullable: true },
              },
              required: [key],
            },
          },
        },
      },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
    },
  };
}

const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object" } } },
});

/** Build the OpenAPI document for the given deployment base URL. */
export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Specboard API",
      version: "1",
      description:
        "The Specboard `/api/v1` REST surface. Authenticate with an API key " +
        "(`x-api-key: sb_…` or `Authorization: Bearer sb_…`). Keys may be " +
        "scoped: a key carries `<resource>:read` / `<resource>:write` grants " +
        "(or none, meaning full access). Multi-org callers name the org with " +
        "the `x-org-slug` header.",
    },
    servers: [{ url: baseUrl }],
    security: [{ ApiKeyAuth: [] }],
    tags: [
      { name: "features", description: "Work items (initiatives, epics, features)." },
      { name: "products", description: "Product backlogs." },
      { name: "repositories", description: "Connected GitHub repositories." },
      { name: "releases", description: "Ship vehicles / versions." },
      { name: "views", description: "Saved backlog filters." },
      { name: "ideas", description: "Captured ideas." },
      { name: "workflow", description: "Status vocabulary and transitions." },
      { name: "keys", description: "API keys." },
      { name: "org", description: "Members and service accounts." },
      { name: "identity", description: "The authenticated caller." },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      responses: {
        Unauthorized: ok("Authentication required."),
        Forbidden: ok("Missing role or API-key scope."),
        NotFound: ok("No such resource."),
        Invalid: ok("The request body or query was invalid."),
      },
    },
    paths: {
      "/api/v1/me": {
        get: {
          tags: ["identity"],
          summary: "The authenticated user, workspace, and role.",
          responses: { "200": ok("The caller."), "401": { $ref: "#/components/responses/Unauthorized" } },
        },
      },
      "/api/v1/features": {
        get: listOp("features", "features", "List work items (opt-in pagination)."),
        post: {
          tags: ["features"],
          summary: "Create a DB-native work item (initiative/epic).",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": ok("The created item."), "422": { $ref: "#/components/responses/Invalid" } },
        },
      },
      "/api/v1/features/{specId}": {
        parameters: [{ name: "specId", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["features"], summary: "One work item in full.", responses: { "200": ok("The item."), "404": { $ref: "#/components/responses/NotFound" } } },
        patch: { tags: ["features"], summary: "Update status/tags/release/assignee. Status is validated against the workflow.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated item."), "422": { $ref: "#/components/responses/Invalid" } } },
        delete: { tags: ["features"], summary: "Delete a DB-native work item.", responses: { "200": ok("Deleted."), "422": { $ref: "#/components/responses/Invalid" } } },
      },
      "/api/v1/statuses": {
        get: { tags: ["workflow"], summary: "The workspace's stages plus the resolved workflow (statuses + legal transitions).", responses: { "200": ok("Stages and workflow.") } },
      },
      "/api/v1/products": {
        get: listOp("products", "products", "List products the caller can see."),
        post: { tags: ["products"], summary: "Create a product (owner only).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The created product."), "422": { $ref: "#/components/responses/Invalid" } } },
      },
      "/api/v1/products/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["products"], summary: "One product.", responses: { "200": ok("The product."), "404": { $ref: "#/components/responses/NotFound" } } },
        patch: { tags: ["products"], summary: "Update product settings (product-admin).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated product.") } },
        delete: { tags: ["products"], summary: "Delete a product (must be empty).", responses: { "204": { description: "Deleted." } } },
      },
      "/api/v1/repositories": {
        get: { tags: ["repositories"], summary: "Connected repositories.", responses: { "200": ok("The repositories.") } },
        post: { tags: ["repositories"], summary: "Connect a repo and run an import (owner only).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The connected repo.") } },
      },
      "/api/v1/repositories/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["repositories"], summary: "One connected repo.", responses: { "200": ok("The repo."), "404": { $ref: "#/components/responses/NotFound" } } },
        patch: { tags: ["repositories"], summary: "Update defaultBranch / specGlobs (owner only).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated repo.") } },
        delete: { tags: ["repositories"], summary: "Disconnect a repo (owner only).", responses: { "204": { description: "Disconnected." } } },
      },
      "/api/v1/releases": {
        get: listOp("releases", "releases", "List releases (dated-first; opt-in pagination)."),
        post: { tags: ["releases"], summary: "Create a release.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The created release.") } },
      },
      "/api/v1/releases/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: { tags: ["releases"], summary: "Update a release.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated release.") } },
        delete: { tags: ["releases"], summary: "Delete a release.", responses: { "204": { description: "Deleted." } } },
      },
      "/api/v1/views": {
        get: { tags: ["views"], summary: "The caller's saved backlog views.", responses: { "200": ok("The views.") } },
        post: { tags: ["views"], summary: "Save the current filters as a named view.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The saved view.") } },
      },
      "/api/v1/views/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: { tags: ["views"], summary: "Rename or re-filter a saved view.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated view."), "404": { $ref: "#/components/responses/NotFound" } } },
        delete: { tags: ["views"], summary: "Delete a saved view.", responses: { "204": { description: "Deleted." } } },
      },
      "/api/v1/ideas": {
        get: listOp("ideas", "ideas", "List ideas (most-voted-first; opt-in pagination)."),
        post: { tags: ["ideas"], summary: "Capture an idea.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The created idea.") } },
      },
      "/api/v1/api-keys": {
        get: { tags: ["keys"], summary: "The caller's API keys (session only).", responses: { "200": ok("The keys.") } },
        post: { tags: ["keys"], summary: "Create an API key with optional scopes (session only).", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, expiresInDays: { type: "integer" }, scopes: { type: "array", items: { type: "string" } } }, required: ["name"] } } } }, responses: { "201": ok("The new key (plaintext once).") } },
      },
      "/api/v1/org/members": {
        get: listOp("org", "members", "List org members (owner only; opt-in pagination)."),
      },
      "/api/v1/org/service-accounts": {
        get: { tags: ["org"], summary: "List service (bot) accounts (owner only).", responses: { "200": ok("The service accounts.") } },
        post: { tags: ["org"], summary: "Create a service account + scoped key (owner, session only).", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expiresInDays: { type: "integer" }, productGrants: { type: "array", items: { type: "object" } } }, required: ["name"] } } } }, responses: { "201": ok("The account and its key (plaintext once).") } },
      },
    },
  };
}
