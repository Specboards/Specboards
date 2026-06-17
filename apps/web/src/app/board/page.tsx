import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { StatusSelect } from "@/components/status-select";
import {
  priorityLabel,
  sortFeatures,
  statusLabel,
} from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { canWrite } from "@/lib/workspace";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Kanban board: features grouped by status, moved via legal transitions. */
export default async function BoardPage() {
  const access = await requireWorkspaceAccess();
  const canEdit = !access || canWrite(access.role);
  const workflow = await resolveWorkflowFor(access);
  const columns = workflow.statuses.filter((s) => s !== "archived");
  const store = await getStore();
  const features = sortFeatures(await store.listFeatures(access ?? undefined));

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Board</h1>
      {features.length === 0 ? (
        <EmptyState canConnect={canConnectRepos(access)} />
      ) : (
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((status) => {
          const cards = features.filter((f) => f.status === status);
          return (
            <div
              key={status}
              className="w-64 shrink-0 rounded-lg bg-muted/50 p-2"
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <StatusDot status={status} />
                <span className="text-sm font-medium">
                  {statusLabel(status)}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {cards.length}
                </span>
              </div>
              <div className="space-y-2">
                {cards.map((f) => (
                  <Card key={f.specId} className="rounded-lg shadow-none">
                    <CardHeader className="space-y-1 p-3">
                      <CardTitle className="text-sm">
                        <Link
                          href={`/feature/${f.specId}`}
                          className="hover:underline"
                        >
                          {f.title}
                        </Link>
                      </CardTitle>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                        >
                          {priorityLabel(f.priority)}
                        </Badge>
                        {f.rolledEstimate !== null && (
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                            title={
                              f.childCount > 0
                                ? "Estimate (rolled up from children)"
                                : "Estimate"
                            }
                          >
                            {f.childCount > 0 ? "Σ" : ""}
                            {f.rolledEstimate}
                          </Badge>
                        )}
                        {f.blockedByCount > 0 && (
                          <Badge
                            variant="destructive"
                            className="text-[10px]"
                            title={`Blocked by ${f.blockedByCount} feature(s)`}
                          >
                            Blocked
                          </Badge>
                        )}
                        {f.childCount > 0 && (
                          <Badge
                            variant="outline"
                            className="text-[10px]"
                            title={`${f.childDoneCount} of ${f.childCount} children done`}
                          >
                            epic {f.childDoneCount}/{f.childCount}
                          </Badge>
                        )}
                        {f.parentSpecId && (
                          <Badge
                            variant="secondary"
                            className="text-[10px]"
                            title="Has a parent epic"
                          >
                            ↳ sub
                          </Badge>
                        )}
                        {f.tags.map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-[10px]"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </CardHeader>
                    <CardContent className="p-3 pt-0">
                      <StatusSelect
                        specId={f.specId}
                        status={f.status}
                        className="h-7 text-xs"
                        canEdit={canEdit}
                        workflow={workflow}
                      />
                    </CardContent>
                  </Card>
                ))}
                {cards.length === 0 && (
                  <p className="px-2 pb-2 text-xs text-muted-foreground">
                    Empty
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
