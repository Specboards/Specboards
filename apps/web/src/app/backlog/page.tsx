import { EmptyState } from "@/components/empty-state";
import { sortFeatures } from "@/lib/feature-helpers";
import { getStore } from "@/lib/store";
import { canWrite } from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";
import { BacklogTable, type BacklogRow } from "./backlog-table";

export const dynamic = "force-dynamic";

/**
 * Backlog: prioritized list of features. Status edits here update metadata
 * only (DB or local file) — spec content stays canonical in git.
 */
export default async function BacklogPage() {
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);
  const store = await getStore();
  const features = sortFeatures(await store.listFeatures(access ?? undefined)).filter(
    (f) => f.status !== "archived",
  );

  // Order rows as a hierarchy: each top-level feature followed by its children.
  const bySpec = new Map(features.map((f) => [f.specId, f]));
  const childrenOf = new Map<string, typeof features>();
  const topLevel: typeof features = [];
  for (const f of features) {
    const parent = f.parentSpecId ? bySpec.get(f.parentSpecId) : undefined;
    if (parent) {
      const arr = childrenOf.get(parent.specId) ?? [];
      arr.push(f);
      childrenOf.set(parent.specId, arr);
    } else {
      topLevel.push(f);
    }
  }
  const rows: BacklogRow[] = [];
  for (const f of topLevel) {
    rows.push({ feature: f, depth: 0 });
    for (const c of childrenOf.get(f.specId) ?? [])
      rows.push({ feature: c, depth: 1 });
  }

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Backlog</h1>
        <p className="text-sm text-muted-foreground">
          Prioritized features. Metadata edits land in the database; spec
          content stays in git.
        </p>
      </div>
      {features.length === 0 ? (
        <EmptyState canConnect={canConnectRepos(access)} />
      ) : (
        <BacklogTable rows={rows} canEdit={canEdit} />
      )}
    </section>
  );
}
