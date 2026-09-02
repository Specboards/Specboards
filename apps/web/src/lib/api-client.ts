"use client";

import { apiFetch } from "@/lib/api-client/request";
import type {
  CreateProductGroupInput,
  CreateProductInput,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  DocArea,
  DocPageInput,
  DocPagePatch,
  DocPageRecord,
  DocSpace,
  InvitationProductGrant,
  LevelUpdate,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgRole,
  ProductGroupPatch,
  ProductGroupRecord,
  ProductMemberInput,
  ProductMemberRecord,
  ProductPatch,
  ProductRecord,
  StageGate,
  StageGateInput,
  StatusStageInput,
  TransitionMode,
  WorkspaceLevel,
  WorkspaceStatus,
} from "@/lib/store/types";

export { AuthRequiredError } from "@/lib/api-client/request";
export * from "@/lib/api-client/assistant";
export * from "@/lib/api-client/ideas";
export * from "@/lib/api-client/notifications";
export * from "@/lib/api-client/planning";
export * from "@/lib/api-client/repositories";
export * from "@/lib/api-client/specs";
export * from "@/lib/api-client/views";
export * from "@/lib/api-client/work-items";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

/**
 * Thrown when org creation is rejected because the chosen slug is taken or
 * reserved. Carries the server's `code` and a free `suggestion` so the setup
 * form can warn and offer an alternative slug.
 */
export class WorkspaceSlugTakenError extends Error {
  constructor(
    message: string,
    readonly code: "slug_taken" | "slug_invalid",
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "WorkspaceSlugTakenError";
  }
}


/** Replace the workspace's hierarchy levels (admin-only); returns the new set. */
export async function updateLevels(
  levels: LevelUpdate[],
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ levels }),
  });
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/**
 * Set which metadata fields are available per level (admin-only). Keys are
 * level keys; null = all fields. Returns the refreshed levels.
 */
export async function updateLevelFields(
  fields: Record<string, string[] | null>,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/fields", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/**
 * Assign a default detail template per level (admin-only). Keys are level
 * keys; null clears the assignment. Returns the refreshed levels.
 */
export async function updateLevelTemplates(
  templates: Record<string, string | null>,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templates, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/** Create a detail template (admin-only on the server); returns it. */
export async function createDetailTemplate(
  input: DetailTemplateInput,
  productId?: string | null,
): Promise<DetailTemplate> {
  const res = await apiFetch("/api/v1/detail-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    template?: DetailTemplate;
    error?: string;
  } | null;
  if (!res.ok || !body?.template) {
    throw new Error(body?.error ?? `Create template failed with ${res.status}`);
  }
  return body.template;
}

/** Update a detail template (admin-only); returns the updated record. */
export async function updateDetailTemplate(
  id: string,
  patch: DetailTemplatePatch,
): Promise<DetailTemplate> {
  const res = await apiFetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    template?: DetailTemplate;
    error?: string;
  } | null;
  if (!res.ok || !body?.template) {
    throw new Error(body?.error ?? `Update template failed with ${res.status}`);
  }
  return body.template;
}

/** Delete a detail template (admin-only). */
export async function deleteDetailTemplate(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete template failed with ${res.status}`);
  }
}

// ── Workflow stages ─────────────────────────────────────────────────────

/**
 * Replace a product's workflow stages, or the workspace default's when
 * `productId` is omitted; returns the new set. An empty list reverts a product
 * to inheriting the default.
 */
export async function updateStatuses(
  stages: StatusStageInput[],
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  const res = await apiFetch("/api/v1/statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    statuses?: WorkspaceStatus[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(body?.error ?? `Update workflow failed with ${res.status}`);
  }
  return body.statuses;
}

/**
 * Set how freely items move between stages. With a `productId` this configures
 * that product (product admins and the workspace owner); without one it sets
 * the workspace default that unconfigured products inherit (owner only). A
 * `null` mode reverts a product to inheriting, and returns the mode it lands on
 * rather than null.
 */
export async function updateTransitionMode(
  mode: TransitionMode | null,
  productId?: string | null,
): Promise<TransitionMode> {
  const res = await apiFetch("/api/v1/statuses", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transitionMode: mode, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    transitionMode?: TransitionMode;
    error?: string;
  } | null;
  if (!res.ok || !body?.transitionMode) {
    throw new Error(
      body?.error ?? `Update transitions failed with ${res.status}`,
    );
  }
  return body.transitionMode;
}

/** Replace the workspace's stage gates (admin-only); returns the new set. */
export async function updateStageGates(
  gates: StageGateInput[],
  productId?: string | null,
): Promise<StageGate[]> {
  const res = await apiFetch("/api/v1/stage-gates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gates, productId: productId ?? null }),
  });
  const body = (await res.json().catch(() => null)) as {
    gates?: StageGate[];
    error?: string;
  } | null;
  if (!res.ok || !body?.gates) {
    throw new Error(
      body?.error ?? `Update stage gates failed with ${res.status}`,
    );
  }
  return body.gates;
}

/** Check/uncheck one stage gate for an item; returns the completed gate ids. */
export async function setGateCompletion(
  specId: string,
  gateId: string,
  completed: boolean,
): Promise<string[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/gates`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gateId, completed }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    completed?: string[];
    error?: string;
  } | null;
  if (!res.ok || !body?.completed) {
    throw new Error(body?.error ?? `Update gate failed with ${res.status}`);
  }
  return body.completed;
}

/**
 * Create the organization (first user only). `seedSampleData` populates a
 * starter board; otherwise the workspace begins empty. Returns the workspace slug.
 */
export async function createWorkspace(
  name: string,
  seedSampleData: boolean,
  slug?: string,
): Promise<{ slug: string }> {
  const res = await apiFetch("/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, seedSampleData, slug }),
  });
  const body = (await res.json().catch(() => null)) as {
    workspace?: { slug: string };
    error?: string;
    code?: "slug_taken" | "slug_invalid";
    suggestion?: string;
  } | null;
  if (!res.ok || !body?.workspace) {
    if (body?.code === "slug_taken" || body?.code === "slug_invalid") {
      throw new WorkspaceSlugTakenError(
        body.error ?? "That organization URL isn't available.",
        body.code,
        body.suggestion,
      );
    }
    throw new Error(
      body?.error ?? `Workspace creation failed with ${res.status}`,
    );
  }
  return body.workspace;
}

// ── Products ────────────────────────────────────────────────────────────

/** Create a product (org-admin only on the server); returns the new record. */
export async function createProduct(
  input: CreateProductInput,
): Promise<ProductRecord> {
  const res = await apiFetch("/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    product?: ProductRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Create product failed with ${res.status}`);
  }
  return body.product;
}

/** Update a product's settings (product-admin only); returns the updated record. */
export async function updateProduct(
  id: string,
  patch: ProductPatch,
): Promise<ProductRecord> {
  const res = await apiFetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    product?: ProductRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Update product failed with ${res.status}`);
  }
  return body.product;
}

/** Delete a product (must have no items). */
export async function deleteProduct(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete product failed with ${res.status}`);
  }
}

// ── Product groups ──────────────────────────────────────────────────────

/** Create a product group (org-admin only); returns the new record. */
export async function createProductGroup(
  input: CreateProductGroupInput,
): Promise<ProductGroupRecord> {
  const res = await apiFetch("/api/v1/product-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    group?: ProductGroupRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.group) {
    throw new Error(body?.error ?? `Create group failed with ${res.status}`);
  }
  return body.group;
}

/** Update a product group (org-admin only); returns the updated record. */
export async function updateProductGroup(
  id: string,
  patch: ProductGroupPatch,
): Promise<ProductGroupRecord> {
  const res = await apiFetch(`/api/v1/product-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    group?: ProductGroupRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.group) {
    throw new Error(body?.error ?? `Update group failed with ${res.status}`);
  }
  return body.group;
}

/** Delete a product group (must have no subgroups or products). */
export async function deleteProductGroup(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/product-groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete group failed with ${res.status}`);
  }
}

/** List a product's members (product-admin only). */
export async function listProductMembers(
  productId: string,
): Promise<ProductMemberRecord[]> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
  );
  const body = (await res.json().catch(() => null)) as {
    members?: ProductMemberRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load members (${res.status}).`);
  return body?.members ?? [];
}

/** Add or update a member's role on a product (upsert). */
export async function setProductMember(
  productId: string,
  input: ProductMemberInput,
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Set member failed with ${res.status}`);
  }
}

/** Remove a member from a product. */
export async function removeProductMember(
  productId: string,
  userId: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Remove member failed with ${res.status}`);
  }
}

/** List the organization's members (org-admin only). */
export async function listOrgMembers(): Promise<OrgMemberRecord[]> {
  const res = await apiFetch("/api/v1/org/members");
  const body = (await res.json().catch(() => null)) as {
    members?: OrgMemberRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load members (${res.status}).`);
  return body?.members ?? [];
}

/** Change a member's org role and/or active flag. Org-admin only. */
export async function updateOrgMember(
  userId: string,
  patch: { role?: OrgRole; active?: boolean },
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Update member failed with ${res.status}`);
  }
}

/** Remove a member from the organization. Org-admin only. */
export async function removeOrgMember(userId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/members/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Remove member failed with ${res.status}`);
  }
}

/** List the org's invitations (org-admin only). */
export async function listInvitations(): Promise<OrgInvitationRecord[]> {
  const res = await apiFetch("/api/v1/org/invitations");
  const body = (await res.json().catch(() => null)) as {
    invitations?: OrgInvitationRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(
      body?.error ?? `Failed to load invitations (${res.status}).`,
    );
  return body?.invitations ?? [];
}

/**
 * Invite someone to the org. `role` is the org role (`owner`/`member`);
 * `productGrants` gives a member per-product access on accept (ignored for an
 * owner). Returns the new invitation.
 */
export async function createInvitation(input: {
  email: string;
  role: OrgRole;
  productGrants?: InvitationProductGrant[];
}): Promise<OrgInvitationRecord> {
  const res = await apiFetch("/api/v1/org/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    invitation?: OrgInvitationRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.invitation) {
    throw new Error(body?.error ?? `Invite failed with ${res.status}`);
  }
  return body.invitation;
}

/** Revoke a pending invitation. Org-admin only. */
export async function revokeInvitation(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/invitations/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Revoke failed with ${res.status}`);
  }
}

/** Re-send a pending invitation (regenerates the token). Org-admin only. */
export async function resendInvitation(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/invitations/${encodeURIComponent(id)}/resend`,
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Resend failed with ${res.status}`);
  }
}

/** Update the organization ("company") name. Admin-only on the server. */
export async function updateWorkspace(name: string): Promise<void> {
  const res = await apiFetch("/api/v1/workspace", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
}

/** Choose (or change) where a Plan-section area's docs live. */
export async function setDocSpace(input: {
  productId: string;
  area: DocArea;
  mode: "local" | "external" | "github";
  externalUrl?: string | null;
  repoId?: string | null;
}): Promise<DocSpace> {
  const res = await apiFetch("/api/v1/doc-spaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    error?: string;
  } | null;
  if (!res.ok || !body?.space) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.space;
}

/** Create a doc folder or page; returns the new record. */
export async function createDocPage(
  input: DocPageInput,
): Promise<DocPageRecord> {
  const res = await apiFetch("/api/v1/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.page;
}

/** Rename, edit, or move a doc page; returns the updated record. */
export async function patchDocPage(
  id: string,
  patch: DocPagePatch,
): Promise<DocPageRecord> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.page;
}

/** Delete a doc page, or a folder and its contents. */
export async function deleteDocPage(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}

/**
 * Create a private GitHub docs repository and bind it as the area's doc
 * source. Returns the updated space plus the created repo's coordinates.
 */
export async function createGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  name: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Connect a repository the GitHub App installation can already access as the
 * area's doc source.
 */
export async function connectGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  owner: string;
  name: string;
  installationId: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: input.productId,
      area: input.area,
      installationId: input.installationId,
      existing: { owner: input.owner, name: input.name },
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Save (commit) one Markdown file in a GitHub-backed doc area. `blobSha` is
 * the sha the file had when loaded (null for a new page); a stale sha means
 * someone else changed the file and the save is rejected. Returns the new sha
 * for the next save.
 */
export async function saveGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  content: string;
  blobSha: string | null;
}): Promise<{ blobSha: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    blobSha?: string;
    error?: string;
  } | null;
  if (!res.ok || typeof body?.blobSha !== "string") {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return { blobSha: body.blobSha };
}

/** Rename (or move) one Markdown file in a GitHub-backed doc area. */
export async function renameGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  toPath: string;
}): Promise<{ path: string; blobSha: string; content: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    blobSha?: string;
    content?: string;
    error?: string;
  } | null;
  if (
    !res.ok ||
    typeof body?.path !== "string" ||
    typeof body.blobSha !== "string" ||
    typeof body.content !== "string"
  ) {
    throw new Error(body?.error ?? `Rename failed with ${res.status}`);
  }
  return { path: body.path, blobSha: body.blobSha, content: body.content };
}

/** Delete one Markdown file in a GitHub-backed doc area (one commit). */
export async function deleteGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  blobSha: string;
}): Promise<void> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}
