"use client";

import type { ItemDetailData } from "@/lib/item-detail";
import type {
  BoardKey,
  BoardPreferences,
  CreatableRelationDirection,
  CreateFeatureInput,
  CreateProductInput,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  DocArea,
  DocPageInput,
  DocPagePatch,
  DocPageRecord,
  DocSpace,
  FeatureDetail,
  FeaturePatch,
  FeatureRecord,
  FeatureRelation,
  GithubLink,
  GithubLinkInput,
  IdeaInput,
  IdeaPatch,
  IdeaRecord,
  IdeaSettings,
  IdeaSettingsPatch,
  IdeaStage,
  InvitationProductGrant,
  LevelUpdate,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgRole,
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
  StageGate,
  StageGateInput,
  StatusStageInput,
  WorkspaceLevel,
  WorkspaceStatus,
} from "@/lib/store/types";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

/**
 * The active org slug, read from the `/[org]/…` route. Every UI page renders
 * under an org segment, so the first path segment is the workspace the user is
 * looking at. We forward it to the API as `x-org-slug` so the server scopes the
 * request to THIS org instead of guessing from the caller's memberships (the
 * multi-org tenant-confusion fix). The server validates it against a real
 * membership, so it's only ever a hint.
 */
function activeOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  const slug = window.location.pathname.split("/")[1];
  return slug ? decodeURIComponent(slug) : null;
}

/**
 * `fetch` for the versioned API that tags each request with the active org.
 * All calls in this module go through here so none can forget the header.
 */
function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const slug = activeOrgSlug();
  const headers = new Headers(init.headers);
  if (slug) headers.set("x-org-slug", slug);
  return fetch(input, { ...init, headers });
}

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
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/context`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    data?: ItemDetailData;
    error?: string;
  } | null;
  if (!res.ok || !body?.data) {
    throw new Error(body?.error ?? `Failed to load item (${res.status}).`);
  }
  return body.data;
}

/** Load a feature's full detail (metadata + spec content) for in-context edit. */
export async function getFeature(specId: string): Promise<FeatureDetail> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`);
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    feature?: FeatureDetail;
    error?: string;
  } | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Failed to load feature (${res.status}).`);
  }
  return body.feature;
}

export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
): Promise<void> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `PATCH failed with ${res.status}`);
  }
}

/** Create a DB-native work item (initiative/epic); returns the new record. */
export async function createWorkItem(
  input: CreateFeatureInput,
): Promise<FeatureRecord> {
  const res = await apiFetch("/api/v1/features", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.feature;
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(specId: string): Promise<void> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `DELETE failed with ${res.status}`);
  }
}

/** The workspace's hierarchy levels, ordered top → leaf. */
export async function listLevels(): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load levels (${res.status}).`);
  return body?.levels ?? [];
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
  if (res.status === 401) throw new AuthRequiredError();
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
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/fields", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templates }),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
): Promise<DetailTemplate> {
  const res = await apiFetch("/api/v1/detail-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete template failed with ${res.status}`);
  }
}

// ── Workflow stages ─────────────────────────────────────────────────────

/** The workspace's workflow stages ([] = built-in default workflow). */
export async function listStatuses(): Promise<WorkspaceStatus[]> {
  const res = await apiFetch("/api/v1/statuses");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: WorkspaceStatus[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load workflow (${res.status}).`);
  return body?.statuses ?? [];
}

/** Replace the workspace's workflow stages (admin-only); returns the new set. */
export async function updateStatuses(
  stages: StatusStageInput[],
): Promise<WorkspaceStatus[]> {
  const res = await apiFetch("/api/v1/statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: WorkspaceStatus[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(body?.error ?? `Update workflow failed with ${res.status}`);
  }
  return body.statuses;
}

/** The workspace's stage gates (checklist items per stage). */
export async function listStageGates(): Promise<StageGate[]> {
  const res = await apiFetch("/api/v1/stage-gates");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    gates?: StageGate[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Failed to load stage gates (${res.status}).`,
    );
  }
  return body?.gates ?? [];
}

/** Replace the workspace's stage gates (admin-only); returns the new set. */
export async function updateStageGates(
  gates: StageGateInput[],
): Promise<StageGate[]> {
  const res = await apiFetch("/api/v1/stage-gates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gates }),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    completed?: string[];
    error?: string;
  } | null;
  if (!res.ok || !body?.completed) {
    throw new Error(body?.error ?? `Update gate failed with ${res.status}`);
  }
  return body.completed;
}

// ── Ideas ────────────────────────────────────────────────────────────────

/** Capture a new idea; returns the new record. */
export async function createIdea(input: IdeaInput): Promise<IdeaRecord> {
  const res = await apiFetch("/api/v1/ideas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Create idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Update an idea's title/description/status/product; returns the record. */
export async function updateIdea(
  id: string,
  patch: IdeaPatch,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Update idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Delete an idea. */
export async function deleteIdea(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete idea failed with ${res.status}`);
  }
}

/** Set the caller's vote on an idea; returns the updated record. */
export async function setIdeaVote(
  id: string,
  voted: boolean,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voted }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Vote failed with ${res.status}`);
  }
  return body.idea;
}

/** Promote an idea into a feature; returns both records. */
export async function promoteIdea(
  id: string,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const res = await apiFetch(
    `/api/v1/ideas/${encodeURIComponent(id)}/promote`,
    {
      method: "POST",
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea || !body?.feature) {
    throw new Error(body?.error ?? `Promote failed with ${res.status}`);
  }
  return { idea: body.idea, feature: body.feature };
}

/** Replace the workspace's idea review stages (admin-only); returns the set. */
export async function updateIdeaStatuses(
  stages: StatusStageInput[],
): Promise<IdeaStage[]> {
  const res = await apiFetch("/api/v1/idea-statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: IdeaStage[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(
      body?.error ?? `Update idea stages failed with ${res.status}`,
    );
  }
  return body.statuses;
}

/** Update the workspace's Ideas configuration (admin-only); returns it. */
export async function updateIdeaSettings(
  patch: IdeaSettingsPatch,
): Promise<IdeaSettings> {
  const res = await apiFetch("/api/v1/idea-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    settings?: IdeaSettings;
    error?: string;
  } | null;
  if (!res.ok || !body?.settings) {
    throw new Error(
      body?.error ?? `Update Ideas settings failed with ${res.status}`,
    );
  }
  return body.settings;
}

/** Define a custom property (admin-only on the server); returns it. */
export async function createProperty(
  input: PropertyInput,
): Promise<PropertyDef> {
  const res = await apiFetch("/api/v1/properties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
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
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Update property failed with ${res.status}`);
  }
  return body.property;
}

/** Delete a custom property definition (admin-only). */
export async function deleteProperty(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete property failed with ${res.status}`);
  }
}

/** Create a release (admin-only on the server); returns the new record. */
export async function createRelease(
  input: ReleaseInput,
): Promise<ReleaseRecord> {
  const res = await apiFetch("/api/v1/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
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
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Update release failed with ${res.status}`);
  }
  return body.release;
}

/** Delete a release (admin-only); its items are unscheduled, not deleted. */
export async function deleteRelease(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete release failed with ${res.status}`);
  }
}

/** Create a typed relation from a feature; returns its refreshed relations. */
export async function addRelation(
  specId: string,
  input: { toSpecId: string; direction: CreatableRelationDirection },
): Promise<FeatureRelation[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
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
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Remove relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Persist the acting user's board display preferences for a space. */
export async function saveBoardPreferences(
  prefs: BoardPreferences,
  board: BoardKey = "backlog",
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/board-preferences?board=${encodeURIComponent(board)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Save preferences failed with ${res.status}`,
    );
  }
}

/** Link a GitHub artifact to a feature; returns its refreshed links. */
export async function addGithubLink(
  specId: string,
  input: GithubLinkInput,
): Promise<GithubLink[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
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
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Remove GitHub link failed with ${res.status}`,
    );
  }
  return body?.githubLinks ?? [];
}

/** Save the current backlog filters as a named view. */
export async function saveView(input: SavedViewInput): Promise<SavedView> {
  const res = await apiFetch("/api/v1/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    view?: SavedView;
    error?: string;
  } | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Save view failed with ${res.status}`);
  }
  return body.view;
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
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
  const res = await apiFetch("/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, seedSampleData, slug }),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  const res = await apiFetch("/api/v1/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
      featuresCreated: 0,
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
  if (res.status === 401) throw new AuthRequiredError();
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
      featuresCreated: 0,
    },
    errors: body?.errors ?? [],
  };
}

/**
 * Disconnect a connected repository. Imported board items are kept (detached);
 * only the sync connection and its GitHub links are removed. Admin-only.
 */
export async function disconnectRepository(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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

// ── Products ────────────────────────────────────────────────────────────

/** List the products (sibling backlogs) the caller can see. */
export async function listProducts(): Promise<ProductRecord[]> {
  const res = await apiFetch("/api/v1/products");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    products?: ProductRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load products (${res.status}).`);
  return body?.products ?? [];
}

/** Create a product (org-admin only on the server); returns the new record. */
export async function createProduct(
  input: CreateProductInput,
): Promise<ProductRecord> {
  const res = await apiFetch("/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete product failed with ${res.status}`);
  }
}

/** List a product's members (product-admin only). */
export async function listProductMembers(
  productId: string,
): Promise<ProductMemberRecord[]> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
  );
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
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
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}
