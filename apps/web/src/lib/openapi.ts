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
      title: "Specboards API",
      version: "1",
      description:
        "The Specboards `/api/v1` REST surface. Authenticate with an API key " +
        "(`x-api-key: sb_…` or `Authorization: Bearer sb_…`). Keys may be " +
        "scoped: a key carries `<resource>:read` / `<resource>:write` grants " +
        "(or none, meaning full access). Multi-org callers name the org with " +
        "the `x-org-slug` header. The same scopes govern the MCP endpoint " +
        "(`/api/mcp`), where each tool requires the scope its REST equivalent " +
        "does: a `features:read` key can call `list_items` but not " +
        "`create_item`. Endpoints outside `/api/v1` reject API keys.",
    },
    servers: [{ url: baseUrl }],
    security: [{ ApiKeyAuth: [] }],
    tags: [
      { name: "features", description: "Work items (initiatives, epics, features)." },
      { name: "products", description: "Product backlogs." },
      { name: "repositories", description: "Connected GitHub repositories." },
      { name: "releases", description: "Ship vehicles / versions." },
      { name: "cycles", description: "Sprints / iterations: date-bounded time boxes, orthogonal to releases." },
      { name: "goals", description: "Objectives and key results, with the work that ladders up to them." },
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
        patch: { tags: ["features"], summary: "Update status/tags/release/assignee. Status is validated against the workflow; ?advance=1 walks a multi-stage move through the intermediate stages.", parameters: [{ name: "advance", in: "query", required: false, schema: { type: "boolean" }, description: "Walk intermediate stages when the target status is not reachable in one move. Stage gates still apply at every stage passed." }], requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated item."), "422": { $ref: "#/components/responses/Invalid" } } },
        delete: { tags: ["features"], summary: "Delete a DB-native work item.", responses: { "200": ok("Deleted."), "422": { $ref: "#/components/responses/Invalid" } } },
      },
      "/api/v1/features/{specId}/content": {
        parameters: [{ name: "specId", in: "path", required: true, schema: { type: "string" } }],
        put: { tags: ["features"], summary: "Replace a spec's Markdown body and write it back to the connected repo. Frontmatter (and so the stable id) is preserved. Where it lands follows the repo's writeMode: direct commits onto the default branch, pr (the default) commits to a working branch and proposes it, joining the pull request already open for that file.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string", description: "Markdown after the frontmatter." }, message: { type: "string", description: "Commit message; defaults to docs(specboard): update <path>." }, expectedBlobSha: { type: "string", description: "Blob sha of the version you loaded (a feature's blobSha). The write is refused with 409 if the file changed in git since. Omit for an unguarded last-write-wins save." } } } } } }, responses: { "200": ok("The written spec: specId, path, commitSha, blobSha, plus pullRequest (number, url, branch, created) when the change was proposed for review rather than committed. Its presence means the board still shows the previous text."), "409": ok("The spec changed in git since expectedBlobSha was read. The body carries conflict.currentContent and conflict.currentBlobSha; resend with expectedBlobSha set to that sha to overwrite deliberately."), "422": { $ref: "#/components/responses/Invalid" } } },
      },
      "/api/v1/specs": {
        post: { tags: ["features"], summary: "Create a spec file, commit it to a connected repo, and sync it onto the board. With workItemId the spec attaches to that existing leaf item, keeping its id, status, assignee, parent and history; with parentSpecId a new item is created and nested under that card. The two are mutually exclusive.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, body: { type: "string", description: "Markdown body, no frontmatter. Defaults to a stub." }, workItemId: { type: "string", format: "uuid", description: "Existing leaf work item to attach the spec to." }, parentSpecId: { type: "string", format: "uuid", description: "Card to nest the newly created item under. Not valid with workItemId." }, templateId: { type: "string", format: "uuid", description: "Detail template to start the body from. Only used when the spec would otherwise be blank, so it never displaces a supplied body or an attached card's description. Defaults to the leaf level's assigned template." }, repoId: { type: "string", description: "Target repository; defaults to the spec repo." }, message: { type: "string", description: "Commit message; defaults to docs(specboard): add <path>." } } } } } }, responses: { "201": ok("The created spec (specId, path, commitSha), plus parentWarning when the file was committed but nesting it failed."), "422": { $ref: "#/components/responses/Invalid" } } },
      },
      "/api/v1/statuses": {
        get: { tags: ["workflow"], summary: "The workspace's stages, its transition mode, plus the resolved workflow (statuses + legal transitions).", responses: { "200": ok("Stages, transition mode, and workflow.") } },
        patch: { tags: ["workflow"], summary: "Set the transition mode, strict or flexible (admin).", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { transitionMode: { type: "string", enum: ["strict", "flexible"] } }, required: ["transitionMode"] } } } }, responses: { "200": ok("The new transition mode."), "422": { $ref: "#/components/responses/Invalid" } } },
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
      "/api/v1/releases/{id}/items": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["releases"], summary: "The work scheduled into a release, grouped by hierarchy level (top level first).", responses: { "200": ok("The release's items, grouped by level."), "404": { $ref: "#/components/responses/NotFound" } } },
      },
      "/api/v1/cycles": {
        get: listOp("cycles", "cycles", "List cycles (active first, then upcoming, then most recently complete). Each carries a derived state."),
        post: { tags: ["cycles"], summary: "Create a cycle.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The created cycle.") } },
      },
      "/api/v1/cycles/generate": {
        post: { tags: ["cycles"], summary: "Generate a run of cycles from a cadence (e.g. fortnightly to the end of the year). All or nothing: a name clash creates none.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The cycles created, in date order.") } },
      },
      "/api/v1/cycles/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: { tags: ["cycles"], summary: "Update a cycle's name, product, dates or notes.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated cycle.") } },
        delete: { tags: ["cycles"], summary: "Delete a cycle (its items are unscheduled, not deleted).", responses: { "204": { description: "Deleted." } } },
      },
      "/api/v1/cycles/{id}/rollover": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { tags: ["cycles"], summary: "Move this cycle's unfinished work into another cycle.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("How many items moved.") } },
      },
      "/api/v1/goals": {
        get: listOp("goals", "goals", "List goals with their key results. Progress (outcome) and deliveryProgress (output) are both computed on read, never stored."),
        post: { tags: ["goals"], summary: "Create a goal.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The created goal.") } },
      },
      "/api/v1/goals/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["goals"], summary: "One goal with its key results and contributing work.", responses: { "200": ok("The goal and its contributions.") } },
        patch: { tags: ["goals"], summary: "Update a goal.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The updated goal.") } },
        delete: { tags: ["goals"], summary: "Delete a goal (its linked work items are untouched).", responses: { "204": { description: "Deleted." } } },
      },
      "/api/v1/goals/{id}/key-results": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { tags: ["goals"], summary: "Add a key result to a goal.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The goal, with its recomputed progress.") } },
      },
      "/api/v1/goals/{id}/links": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { tags: ["goals"], summary: "Work items laddering up to this goal.", responses: { "200": ok("The contributions.") } },
        post: { tags: ["goals"], summary: "Link a work item to this goal (many-to-many; may cross products).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "201": ok("The refreshed contributions.") } },
        delete: { tags: ["goals"], summary: "Unlink a work item (pass ?specId=).", responses: { "200": ok("The refreshed contributions.") } },
      },
      "/api/v1/key-results/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: { tags: ["goals"], summary: "Update a key result (most often its currentValue).", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": ok("The goal, with its recomputed progress.") } },
        delete: { tags: ["goals"], summary: "Delete a key result.", responses: { "200": ok("The goal, with its recomputed progress.") } },
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
