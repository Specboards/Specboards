import {
  createDb,
  eq,
  features,
  githubInstallations,
  repositories,
  schema,
  sql,
  workspaces,
} from "@specboard/db";

/**
 * Direct database access for E2E setup/teardown. The Playwright test process and
 * the app server share the same Postgres, so tests seed connected repos and
 * reset board state here rather than driving unimplemented UI. Connects as the
 * table owner (RLS bypassed), same as the app's owner connection.
 */
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for E2E database access.");
  return createDb(url);
}

/** Wipe all user + workspace data so the next sign-up becomes the first admin. */
export async function truncateAll(): Promise<void> {
  // CASCADE clears sessions/accounts (FK to users) and every workspace-scoped
  // table (FK to workspaces). RESTART IDENTITY keeps runs reproducible.
  await db().execute(
    sql`TRUNCATE TABLE ${schema.users}, ${workspaces} RESTART IDENTITY CASCADE`,
  );
}

/** The single workspace (there is one after setup); its id + slug for routing. */
export async function getWorkspace(): Promise<{ id: string; slug: string }> {
  const rows = await db()
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .limit(1);
  const ws = rows[0];
  if (!ws) throw new Error("No workspace found; global setup did not run?");
  return ws;
}

/** Clear connected repos and imported board items for a clean per-test slate. */
export async function resetBoard(workspaceId: string): Promise<void> {
  // Deleting features cascades their spec_index rows; then drop the repos.
  await db().delete(features).where(eq(features.workspaceId, workspaceId));
  await db().delete(repositories).where(eq(repositories.workspaceId, workspaceId));
  await db()
    .delete(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId));
}

/** Bind a GitHub App installation to the workspace (mirrors the setup callback). */
export async function seedInstallation(input: {
  workspaceId: string;
  installationId?: string;
  accountLogin?: string;
  accountType?: "Organization" | "User";
}): Promise<void> {
  await db().insert(githubInstallations).values({
    workspaceId: input.workspaceId,
    installationId: input.installationId ?? "e2e-installation",
    accountLogin: input.accountLogin ?? "acme",
    accountType: input.accountType ?? "Organization",
  });
}

/** Insert a connected repository row, returning its id. Mirrors a real connect. */
export async function seedRepository(input: {
  workspaceId: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  githubInstallationId?: string;
}): Promise<string> {
  const [row] = await db()
    .insert(repositories)
    .values({
      workspaceId: input.workspaceId,
      owner: input.owner,
      name: input.name,
      defaultBranch: input.defaultBranch ?? "main",
      githubInstallationId: input.githubInstallationId ?? "e2e-installation",
    })
    .returning({ id: repositories.id });
  if (!row) throw new Error("Failed to seed repository row.");
  return row.id;
}
