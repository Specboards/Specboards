import {
  and,
  createDb,
  detailTemplates,
  docPages,
  docSpaces,
  eq,
  features,
  githubInstallations,
  ideaSettings,
  ideaStatuses,
  ideas,
  isNull,
  outboxEvents,
  releases,
  repositories,
  schema,
  sql,
  webhookEndpoints,
  workspaceProperties,
  workspaces,
} from "@specboard/db";

/**
 * Direct database access for E2E setup/teardown. The Playwright test process and
 * the app server share the same Postgres, so tests seed connected repos and
 * reset board state here rather than driving unimplemented UI. Connects as the
 * table owner (RLS bypassed), same as the app's owner connection.
 */
let client: ReturnType<typeof createDb> | undefined;

function db() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set for E2E database access.");
    // One shared client for the whole runner process: a fresh pool per call
    // exhausts Postgres max_connections as the suite grows.
    client = createDb(url);
  }
  return client;
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

/** Remove every release in the workspace (items are unscheduled by SET NULL). */
export async function resetReleases(workspaceId: string): Promise<void> {
  await db().delete(releases).where(eq(releases.workspaceId, workspaceId));
}

/** Remove every idea, review stage, and portal setting in the workspace. */
export async function resetIdeas(workspaceId: string): Promise<void> {
  // Deleting ideas cascades their votes; then drop stages + settings.
  await db().delete(ideas).where(eq(ideas.workspaceId, workspaceId));
  await db().delete(ideaStatuses).where(eq(ideaStatuses.workspaceId, workspaceId));
  await db().delete(ideaSettings).where(eq(ideaSettings.workspaceId, workspaceId));
}

/** Remove every doc space and doc page (Plan-section areas). */
export async function resetDocs(workspaceId: string): Promise<void> {
  await db().delete(docPages).where(eq(docPages.workspaceId, workspaceId));
  await db().delete(docSpaces).where(eq(docSpaces.workspaceId, workspaceId));
}

/** Remove every webhook endpoint (and its deliveries, via cascade). */
export async function resetWebhooks(workspaceId: string): Promise<void> {
  await db()
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, workspaceId));
  await db().delete(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
}

/** Count outbox events for a workspace, split by whether the relay processed them. */
export async function outboxCounts(
  workspaceId: string,
): Promise<{ total: number; unprocessed: number }> {
  const d = db();
  const [total] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(eq(outboxEvents.workspaceId, workspaceId));
  const [unprocessed] = await d
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.workspaceId, workspaceId),
        isNull(outboxEvents.processedAt),
      ),
    );
  return { total: total?.n ?? 0, unprocessed: unprocessed?.n ?? 0 };
}

/** Remove every custom property definition in the workspace. */
export async function resetProperties(workspaceId: string): Promise<void> {
  await db()
    .delete(workspaceProperties)
    .where(eq(workspaceProperties.workspaceId, workspaceId));
}

/** Remove every detail template (levels pointing at them are SET NULL). */
export async function resetDetailTemplates(workspaceId: string): Promise<void> {
  await db()
    .delete(detailTemplates)
    .where(eq(detailTemplates.workspaceId, workspaceId));
}

/** Number of GitHub App installations bound to the workspace. */
export async function installationCount(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(githubInstallations)
    .where(eq(githubInstallations.workspaceId, workspaceId));
  return row?.n ?? 0;
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
