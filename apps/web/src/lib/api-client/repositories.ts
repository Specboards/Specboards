"use client";

import { apiFetch } from "@/lib/api-client/request";

/** Summary returned by an initial/repeat spec import. */
export interface SyncResult {
  upserted: number;
  skipped: number;
  idsInjected: number;
  /** Specs that attached to a work item that already existed. */
  attached: number;
  /** Imports that matched no existing grouping and landed unparented. */
  unparented: number;
}

interface ConnectRepoInput {
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
  const res = await apiFetch("/api/v1/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    sync?: SyncResult | { error: string } | null;
    error?: string;
  } | null;
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
export async function scanWorkspaceSpecs(): Promise<{
  repos: RepoScan[];
  totalSpecs: number;
}> {
  const res = await apiFetch("/api/v1/repositories/scan");
  const body = (await res.json().catch(() => null)) as {
    repos?: RepoScan[];
    totalSpecs?: number;
    error?: string;
  } | null;
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
  const res = await apiFetch("/api/v1/repositories/starter-spec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    summary?: SyncResult;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Couldn't create the starter spec (${res.status}).`,
    );
  }
  return {
    path: body?.path ?? "",
    summary: body?.summary ?? {
      upserted: 0,
      skipped: 0,
      idsInjected: 0,
      attached: 0,
      unparented: 0,
    },
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
  const res = await apiFetch("/api/v1/repositories/import", { method: "POST" });
  const body = (await res.json().catch(() => null)) as {
    summary?: SyncResult;
    errors?: ImportResult["errors"];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Import failed with ${res.status}`);
  }
  return {
    summary: body?.summary ?? {
      upserted: 0,
      skipped: 0,
      idsInjected: 0,
      attached: 0,
      unparented: 0,
    },
    errors: body?.errors ?? [],
  };
}

/** A connected repository as the API returns it (subset of the DB row). */
interface ConnectedRepository {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  config: { version: number; specGlobs?: string[]; writeMode?: string } | null;
  githubInstallationId: string;
  /** Admin override of the repo config's writeMode; null means "use the config". */
  writeModeOverride?: "pr" | "direct" | null;
}

/**
 * Update a connected repo's default branch, spec-import globs, and/or write
 * mode override. Admin-only on the server; returns the updated record.
 *
 * `writeModeOverride: null` is meaningful rather than absent: it clears the
 * override and hands the decision back to the repo's `.specboards/config.yml`.
 */
export async function updateRepository(
  id: string,
  patch: {
    defaultBranch?: string;
    specGlobs?: string[];
    writeModeOverride?: "pr" | "direct" | null;
  },
): Promise<ConnectedRepository> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as {
    repository?: ConnectedRepository;
    error?: string;
  } | null;
  if (!res.ok || !body?.repository) {
    throw new Error(
      body?.error ?? `Update repository failed with ${res.status}`,
    );
  }
  return body.repository;
}

/**
 * Disconnect a connected repository. Imported board items are kept (detached);
 * only the sync connection and its GitHub links are removed. Admin-only.
 */
export async function disconnectRepository(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
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
  const res = await apiFetch("/api/v1/github/installations/repositories");
  const body = (await res.json().catch(() => null)) as
    | (Partial<InstallationConnectState> & {
        error?: string;
      })
    | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Failed to load repositories (${res.status}).`,
    );
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
  const res = await apiFetch("/api/v1/github/installations/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    repository?: CreatedSpecRepo;
    error?: string;
  } | null;
  if (!res.ok || !body?.repository) {
    throw new Error(
      body?.error ?? `Couldn't create the repository (${res.status}).`,
    );
  }
  return body.repository;
}

/** What the deployment's App looks like once manual credentials are accepted. */
interface ManualGithubAppResult {
  slug: string;
  name: string;
  /** False when no webhook secret was supplied, so pushes will not reconcile. */
  webhookConfigured: boolean;
}

/**
 * Configure the deployment's GitHub App from credentials the operator created
 * by hand, for a self-host that GitHub cannot reach and so cannot use the
 * one-click manifest flow. The server verifies them against `GET /app` before
 * storing, so a rejection here means the credentials are wrong, not that the
 * save failed.
 */
export async function saveManualGithubApp(input: {
  appId: string;
  privateKey: string;
  clientSecret: string;
  webhookSecret?: string;
  clientId?: string;
}): Promise<ManualGithubAppResult> {
  const res = await apiFetch("/api/v1/github/app/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    slug?: string;
    name?: string;
    webhookConfigured?: boolean;
    error?: string;
  } | null;
  if (!res.ok || !body?.ok) {
    throw new Error(
      body?.error ?? `Couldn't save the GitHub credentials (${res.status}).`,
    );
  }
  return {
    slug: body.slug ?? "",
    name: body.name ?? "",
    webhookConfigured: body.webhookConfigured ?? false,
  };
}

/** A repo's product links (see /api/v1/repositories/:id/products). */
export interface RepoProductLinksPayload {
  repoId: string;
  productIds: string[];
  defaultProductId: string | null;
}

/** Replace a repo's product links + default product (org-admin only). */
export async function setRepositoryProducts(
  repoId: string,
  input: { productIds: string[]; defaultProductId: string | null },
): Promise<RepoProductLinksPayload> {
  const res = await apiFetch(
    `/api/v1/repositories/${encodeURIComponent(repoId)}/products`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json().catch(() => null)) as
    (RepoProductLinksPayload & { error?: string }) | null;
  if (!res.ok || !body || body.error) {
    throw new Error(
      body?.error ?? `Updating repo products failed with ${res.status}`,
    );
  }
  return body;
}
