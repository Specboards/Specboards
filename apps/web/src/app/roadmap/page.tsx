import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import {
  priorityLabel,
  sortFeatures,
  statusLabel,
} from "@/lib/feature-helpers";
import { getStore } from "@/lib/store";
import { canConnectRepos, requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Roadmap: features grouped by quarter, unscheduled work last. */
export default async function RoadmapPage() {
  const access = await requireWorkspaceAccess();
  const store = await getStore();
  const features = sortFeatures(await store.listFeatures(access ?? undefined)).filter(
    (f) => f.status !== "archived",
  );

  const quarters = [
    ...new Set(
      features.flatMap((f) => (f.roadmapQuarter ? [f.roadmapQuarter] : [])),
    ),
  ].sort();
  const groups: Array<{ label: string; quarter: string | null }> = [
    ...quarters.map((q) => ({ label: q, quarter: q as string | null })),
    { label: "Unscheduled", quarter: null },
  ];

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Roadmap</h1>
      {features.length === 0 ? (
        <EmptyState canConnect={canConnectRepos(access)} />
      ) : (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {groups.map(({ label, quarter }) => {
          const items = features.filter((f) => f.roadmapQuarter === quarter);
          return (
            <div key={label} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                {label}
              </h2>
              {items.map((f) => (
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
                    <CardDescription className="flex items-center gap-2 text-xs">
                      <StatusDot status={f.status} />
                      {statusLabel(f.status)}
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px]"
                      >
                        {priorityLabel(f.priority)}
                      </Badge>
                    </CardDescription>
                  </CardHeader>
                </Card>
              ))}
              {items.length === 0 && (
                <p className="text-xs text-muted-foreground">Empty</p>
              )}
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
