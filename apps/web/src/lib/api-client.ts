"use client";

import type {
  BoardPreferences,
  CreatableRelationDirection,
  CreateFeatureInput,
  CreateProductInput,
  FeatureDetail,
  FeaturePatch,
  FeatureRecord,
  FeatureRelation,
  GithubLink,
  GithubLinkInput,
  LevelUpdate,
  ProductMemberInput,
  ProductMemberRecord,
  ProductPatch,
  ProductRecord,
  SavedView,
  SavedViewInput,
  WorkspaceLevel,
} from "@/lib/store/types";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

/** Thrown when a write is rejected for lack of a session (HTTP 401). */
export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthRequiredError";
  }
}

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

/** Load a feature's full detail (metadata + spec content) for in-context edit. */
export async function getFeature(specId: string): Promise<FeatureDetail> {
  const res = await fetch(`/api/v1/features/${encodeURIComponent(specId)}`);
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { feature?: FeatureDetail; error?: string }
    | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Failed to load feature (${res.status}).`);
  }
  return body.feature;
}

export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
): Promise<void> {
  const res = await fetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `PATCH failed with ${res.status}`);
  }
}

/** Create a DB-native work item (initiative/epic); returns the new record. */
export async function createWorkItem(
  input: CreateFeatureInput,
): Promise<FeatureRecord> {
  const res = await fetch("/api/v1/features", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { feature?: FeatureRecord; error?: string }
    | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.feature;
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(specId: string): Promise<void> {
  const res = await fetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `DELETE failed with ${res.status}`);
  }
}

/** Replace the workspace's hierarchy levels (admin-only); returns the new set. */
export async function updateLevels(
  levels: LevelUpdate[],
): Promise<WorkspaceLevel[]> {
  const res = await fetch("/api/v1/levels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ levels }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { levels?: WorkspaceLevel[]; error?: string }
    | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/** Create a typed relation from a feature; returns its refreshed relations. */
export async function addRelation(
  specId: string,
  input: { toSpecId: string; direction: CreatableRelationDirection },
): Promise<FeatureRelation[]> {
  const res = await fetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { relations?: FeatureRelation[]; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Remove a relation by id; returns the feature's refreshed relations. */
export async function removeRelation(
  specId: string,
  linkId: string,
): Promise<FeatureRelation[]> {
  const res = await fetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { relations?: FeatureRelation[]; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Remove relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Persist the acting user's board display preferences. */
export async function saveBoardPreferences(
  prefs: BoardPreferences,
): Promise<void> {
  const res = await fetch("/api/v1/board-preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Save preferences failed with ${res.status}`);
  }
}

/** Link a GitHub artifact to a feature; returns its refreshed links. */
export async function addGithubLink(
  specId: string,
  input: GithubLinkInput,
): Promise<GithubLink[]> {
  const res = await fetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { githubLinks?: GithubLink[]; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add GitHub link failed with ${res.status}`);
  }
  return body?.githubLinks ?? [];
}

/** Remove a GitHub link by id; returns the feature's refreshed links. */
export async function removeGithubLink(
  specId: string,
  linkId: string,
): Promise<GithubLink[]> {
  const res = await fetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { githubLinks?: GithubLink[]; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Remove GitHub link failed with ${res.status}`);
  }
  return body?.githubLinks ?? [];
}

/** Save the current backlog filters as a named view. */
export async function saveView(input: SavedViewInput): Promise<SavedView> {
  const res = await fetch("/api/v1/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { view?: SavedView; error?: string }
    | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Save view failed with ${res.status}`);
  }
  return body.view;
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  const res = await fetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete view failed with ${res.status}`);
  }
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
  const res = await fetch("/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, seedSampleData, slug }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | {
        workspace?: { slug: string };
        error?: string;
        code?: "slug_taken" | "slug_invalid";
        suggestion?: string;
      }
    | null;
  if (!res.ok || !body?.workspace) {
    if (body?.code === "slug_taken" || body?.code === "slug_invalid") {
      throw new WorkspaceSlugTakenError(
        body.error ?? "That organization URL isn't available.",
        body.code,
        body.suggestion,
      );
    }
    throw new Error(body?.error ?? `Workspace creation failed with ${res.status}`);
  }
  return body.workspace;
}

/** Summary returned by an initial/repeat spec import. */
export interface SyncResult {
  upserted: number;
  skipped: number;
  idsInjected: number;
  featuresCreated: number;
}

export interface ConnectRepoInput {
  installationId: string;
  owner: string;
  name: string;
  defaultBranch?: string;
}

/**
 * Connect (or re-sync) a GitHub repository and run an import. Admin-only on the
 * server. The repository upsert always succeeds when the input is valid; the
 * import may still fail (e.g. the App isn't installed yet), surfaced as
 * `sync.error` rather than a thrown error.
 */
export async function connectRepository(
  input: ConnectRepoInput,
): Promise<{ sync: SyncResult | { error: string } }> {
  const res = await fetch("/api/v1/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { sync?: SyncResult | { error: string }; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  return { sync: body?.sync ?? { error: "No sync summary returned." } };
}

/** A repository the pending GitHub App installation can access. */
export interface InstallationRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * The repos available to connect from the admin's pending GitHub App
 * installation (captured by the setup callback). `installationId` is null when
 * there's no pending installation — show the "Connect GitHub" button instead.
 */
export async function listInstallationRepositories(): Promise<{
  installationId: string | null;
  repositories: InstallationRepo[];
}> {
  const res = await fetch("/api/v1/github/installations/repositories");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    installationId?: string | null;
    repositories?: InstallationRepo[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Failed to load repositories (${res.status}).`);
  }
  return {
    installationId: body?.installationId ?? null,
    repositories: body?.repositories ?? [],
  };
}

// ── Products ────────────────────────────────────────────────────────────

/** List the products (sibling backlogs) the caller can see. */
export async function listProducts(): Promise<ProductRecord[]> {
  const res = await fetch("/api/v1/products");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { products?: ProductRecord[]; error?: string }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `Failed to load products (${res.status}).`);
  return body?.products ?? [];
}

/** Create a product (org-admin only on the server); returns the new record. */
export async function createProduct(
  input: CreateProductInput,
): Promise<ProductRecord> {
  const res = await fetch("/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { product?: ProductRecord; error?: string }
    | null;
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
  const res = await fetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { product?: ProductRecord; error?: string }
    | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Update product failed with ${res.status}`);
  }
  return body.product;
}

/** Delete a product (must have no items). */
export async function deleteProduct(id: string): Promise<void> {
  const res = await fetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete product failed with ${res.status}`);
  }
}

/** List a product's members (product-admin only). */
export async function listProductMembers(
  productId: string,
): Promise<ProductMemberRecord[]> {
  const res = await fetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { members?: ProductMemberRecord[]; error?: string }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `Failed to load members (${res.status}).`);
  return body?.members ?? [];
}

/** Add or update a member's role on a product (upsert). */
export async function setProductMember(
  productId: string,
  input: ProductMemberInput,
): Promise<void> {
  const res = await fetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Set member failed with ${res.status}`);
  }
}

/** Remove a member from a product. */
export async function removeProductMember(
  productId: string,
  userId: string,
): Promise<void> {
  const res = await fetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Remove member failed with ${res.status}`);
  }
}

/** Update the organization ("company") name. Admin-only on the server. */
export async function updateWorkspace(name: string): Promise<void> {
  const res = await fetch("/api/v1/workspace", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
}
