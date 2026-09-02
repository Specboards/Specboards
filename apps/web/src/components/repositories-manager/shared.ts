import type {
  SyncResult,
  WorkspaceInstallation,
} from "@/lib/api-client/repositories";

/**
 * The vocabulary the repository settings flows share.
 *
 * Four flows sit on this screen (importing specs, setting up the GitHub App,
 * managing a connected repository, and connecting a new one) and each lives in
 * its own module. What is here is what more than one of them needs: the shape
 * of a connected repository, and the two helpers that turn a server response
 * into something a person reads.
 */

export interface ConnectedRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: string;
  /** The workspace's dedicated spec repository (one-click created). */
  isSpecRepo?: boolean;
  /** Parsed `.specboards/config.yml`, for the write mode it declares. */
  config?: { writeMode?: string } | null;
  /** Admin override of that write mode; null means the config decides. */
  writeModeOverride?: "pr" | "direct" | null;
}

export type SetupNotice = { kind: "ok" | "error"; message: string } | null;

/** A product option for the per-repo link editor. */
export interface RepoProductOption {
  id: string;
  name: string;
}

/** The workspace's organization installation to target for repo creation. */
export function orgInstallationOf(
  installations: WorkspaceInstallation[],
): string | null {
  return (
    installations.find((i) => i.accountType === "Organization")
      ?.installationId ?? null
  );
}

export type Status = { kind: "ok" | "error"; message: string } | null;

export function syncMessage(sync: SyncResult | { error: string }): {
  kind: "ok" | "error";
  message: string;
} {
  if ("error" in sync) return { kind: "error", message: sync.error };
  const parts = [`${sync.upserted} imported`, `${sync.skipped} unchanged`];
  if (sync.idsInjected > 0)
    parts.push(`${sync.idsInjected} stable id(s) assigned`);
  if (sync.attached > 0)
    parts.push(`${sync.attached} attached to existing item(s)`);
  if (sync.unparented > 0) parts.push(`${sync.unparented} unassigned`);
  return { kind: "ok", message: parts.join(" · ") };
}
