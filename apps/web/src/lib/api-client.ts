"use client";

import type { ItemDetailData } from "@/lib/item-detail";
import type {
  BoardPreferences,
  CreatableRelationDirection,
  CreateFeatureInput,
  CreateProductInput,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
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
  PropertyDef,
  PropertyInput,
  PropertyPatch,
  ReleaseInput,
  ReleasePatch,
  ReleaseRecord,
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

/**
 * Load the full item-detail bundle (metadata + properties + hierarchy +
 * candidates + edit rights) the flyout renders. Mirrors what the full item page
 * assembles server-side, so both views show the same content.
 */
export async function getItemDetail(specId: string): Promise<ItemDetailData> {
  const res = await fetch(
    `/api/v1/features/${encodeURIComponent(specId)}/context`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { data?: ItemDetailData; error?: string }
    | null;
  if (!res.ok || !body?.data) {
    throw new Error(body?.error ?? `Failed to load item (${res.status}).`);
  }
  return body.data;
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

/** The workspace's hierarchy levels, ordered top → leaf. */
export async function listLevels(): Promise<WorkspaceLevel[]> {
  const res = await fetch("/api/v1/levels");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { levels?: WorkspaceLevel[]; error?: string }
    | null;
  if (!res.ok) throw new Error(body?.error ?? `Failed to load levels (${res.status}).`);
  return body?.levels ?? [];
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

/**
 * Set which metadata fields are available per level (admin-only). Keys are
 * level keys; null = all fields. Returns the refreshed levels.
 */
export async function updateLevelFields(
  fields: Record<string, string[] | null>,
): Promise<WorkspaceLevel[]> {
  const res = await fetch("/api/v1/levels/fields", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
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

/**
 * Assign a default detail template per level (admin-only). Keys are level
 * keys; null clears the assignment. Returns the refreshed levels.
 */
export async function updateLevelTemplates(
  templates: Record<string, string | null>,
): Promise<WorkspaceLevel[]> {
  const res = await fetch("/api/v1/levels/templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templates }),
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

/** Create a detail template (admin-only on the server); returns it. */
export async function createDetailTemplate(
  input: DetailTemplateInput,
): Promise<DetailTemplate> {
  const res = await fetch("/api/v1/detail-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { template?: DetailTemplate; error?: string }
    | null;
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
  const res = await fetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { template?: DetailTemplate; error?: string }
    | null;
  if (!res.ok || !body?.template) {
    throw new Error(body?.error ?? `Update template failed with ${res.status}`);
  }
  return body.template;
}

/** Delete a detail template (admin-only). */
export async function deleteDetailTemplate(id: string): Promise<void> {
  const res = await fetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete template failed with ${res.status}`);
  }
}

/** Define a custom property (admin-only on the server); returns it. */
export async function createProperty(input: PropertyInput): Promise<PropertyDef> {
  const res = await fetch("/api/v1/properties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { property?: PropertyDef; error?: string }
    | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Create property failed with ${res.status}`);
  }
  return body.property;
}

/** Update a custom property (admin-only); returns the updated definition. */
export async function updateProperty(
  id: string,
  patch: PropertyPatch,
): Promise<PropertyDef> {
  const res = await fetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { property?: PropertyDef; error?: string }
    | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Update property failed with ${res.status}`);
  }
  return body.property;
}

/** Delete a custom property definition (admin-only). */
export async function deleteProperty(id: string): Promise<void> {
  const res = await fetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete property failed with ${res.status}`);
  }
}

/** Create a release (admin-only on the server); returns the new record. */
export async function createRelease(input: ReleaseInput): Promise<ReleaseRecord> {
  const res = await fetch("/api/v1/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { release?: ReleaseRecord; error?: string }
    | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Create release failed with ${res.status}`);
  }
  return body.release;
}

/** Update a release (admin-only); returns the updated record. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
): Promise<ReleaseRecord> {
  const res = await fetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { release?: ReleaseRecord; error?: string }
    | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Update release failed with ${res.status}`);
  }
  return body.release;
}

/** Delete a release (admin-only); its items are unscheduled, not deleted. */
export async function deleteRelease(id: string): Promise<void> {
  const res = await fetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete release failed with ${res.status}`);
  }
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
  /** Run the initial import on connect. Defaults to true; the onboarding flow
   *  passes false to defer importing behind an explicit confirmation. */
  sync?: boolean;
}

/**
 * Connect (or re-sync) a GitHub repository and run an import. Admin-only on the
 * server. The repository upsert always succeeds when the input is valid; the
 * import may still fail (e.g. the App isn't installed yet), surfaced as
 * `sync.error` rather than a thrown error.
 */
export async function connectRepository(
  input: ConnectRepoInput,
): Promise<{ sync: SyncResult | { error: string } | null }> {
  const res = await fetch("/api/v1/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { sync?: SyncResult | { error: string } | null; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  // null when the caller deferred the import (sync: false).
  return { sync: body?.sync ?? null };
}

/** One connected repo's spec files found by a read-only scan (no import yet). */
export interface RepoScan {
  repoId: string;
  owner: string;
  name: string;
  specs: { path: string; title: string; hasId: boolean }[];
  error?: string;
}

/**
 * Read-only scan of every connected repo for spec files, without importing.
 * Backs the onboarding "found N specs, create cards?" prompt. Admin-only.
 */
export async function scanWorkspaceSpecs(): Promise<{ repos: RepoScan[]; totalSpecs: number }> {
  const res = await fetch("/api/v1/repositories/scan");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { repos?: RepoScan[]; totalSpecs?: number; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Scan failed with ${res.status}`);
  }
  return { repos: body?.repos ?? [], totalSpecs: body?.totalSpecs ?? 0 };
}

/** The outcome of seeding a starter spec into a repo and importing it. */
export interface StarterSpecResult {
  path: string;
  summary: SyncResult;
}

/**
 * Commit a starter `spec.md` into a connected repo and import it, creating the
 * workspace's first card. Backs the empty-state "build your first spec"
 * walkthrough. Admin-only.
 */
export async function createStarterSpec(input: {
  repoId: string;
  featureName: string;
}): Promise<StarterSpecResult> {
  const res = await fetch("/api/v1/repositories/starter-spec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { path?: string; summary?: SyncResult; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Couldn't create the starter spec (${res.status}).`);
  }
  return {
    path: body?.path ?? "",
    summary: body?.summary ?? { upserted: 0, skipped: 0, idsInjected: 0, featuresCreated: 0 },
  };
}

/** The aggregated outcome of importing specs across all connected repos. */
export interface ImportResult {
  summary: SyncResult;
  errors: { owner: string; name: string; error: string }[];
}

/**
 * Import specs from every connected repo into the board (the "create cards"
 * confirmation behind the onboarding scan). Admin-only.
 */
export async function importWorkspaceSpecs(): Promise<ImportResult> {
  const res = await fetch("/api/v1/repositories/import", { method: "POST" });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { summary?: SyncResult; errors?: ImportResult["errors"]; error?: string }
    | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Import failed with ${res.status}`);
  }
  return {
    summary: body?.summary ?? { upserted: 0, skipped: 0, idsInjected: 0, featuresCreated: 0 },
    errors: body?.errors ?? [],
  };
}

/**
 * Disconnect a connected repository. Imported board items are kept (detached);
 * only the sync connection and its GitHub links are removed. Admin-only.
 */
export async function disconnectRepository(id: string): Promise<void> {
  const res = await fetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Disconnect failed with ${res.status}`);
  }
}

/** A repo a workspace installation can access, tagged with its installation. */
export interface InstallationRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  installationId: string;
}

/** A GitHub App installation bound to the workspace. */
export interface WorkspaceInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** The workspace's installations and every repo they can access. */
export interface InstallationConnectState {
  installations: WorkspaceInstallation[];
  repositories: InstallationRepo[];
  /** Set when some repo lists couldn't be loaded (partial data is possible). */
  error: string | null;
}

/**
 * The workspace's GitHub App installations (persisted by the setup callback)
 * and the repos available to connect from each. Empty `installations` means
 * GitHub hasn't been connected yet: show the "Connect GitHub" button.
 */
export async function listInstallationRepositories(): Promise<InstallationConnectState> {
  const res = await fetch("/api/v1/github/installations/repositories");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as Partial<InstallationConnectState> & {
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Failed to load repositories (${res.status}).`);
  }
  return {
    installations: body?.installations ?? [],
    repositories: body?.repositories ?? [],
    error: body?.error ?? null,
  };
}

/** A spec repo created and connected in one step from the onboarding nudge. */
export interface CreatedSpecRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
}

/**
 * Create a private repo in a workspace organization installation and connect
 * it, for the "dedicated spec repo" onboarding path. Admin-only; the target
 * installation must be bound to the workspace (see `github_installations`).
 */
export async function createSpecRepository(input: {
  name: string;
  installationId: string;
}): Promise<CreatedSpecRepo> {
  const res = await fetch("/api/v1/github/installations/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | { repository?: CreatedSpecRepo; error?: string }
    | null;
  if (!res.ok || !body?.repository) {
    throw new Error(body?.error ?? `Couldn't create the repository (${res.status}).`);
  }
  return body.repository;
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
