import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FeatureMetaForm } from "@/components/feature-meta-form";
import { FeatureRelations } from "@/components/feature-relations";
import { StatusDot } from "@/components/status-dot";
import { getDb } from "@/lib/db";
import { statusLabel } from "@/lib/feature-helpers";
import { resolveRepoConfig } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import { canWrite, listWorkspaceMembers, type WorkspaceMember } from "@/lib/workspace";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/**
 * Feature detail: the spec markdown (canonical in git) beside the metadata
 * sidebar (status/priority/quarter/tags, persisted to the metadata store).
 */
export default async function FeaturePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireWorkspaceAccess();
  const { id } = await params;
  const store = await getStore();
  const feature = await store.getFeature(id, access ?? undefined);
  if (!feature) notFound();

  // Assignee options + custom-field definitions for the metadata form.
  const db = getDb();
  const members: WorkspaceMember[] =
    access && db ? await listWorkspaceMembers(db, access.workspaceId) : [];
  const repoConfig = await resolveRepoConfig(access);
  const customFields = repoConfig?.fields ?? [];

  // Other features the relation editor can point at (excluding this one).
  const candidates = (await store.listFeatures(access ?? undefined))
    .filter((f) => f.specId !== feature.specId)
    .map((f) => ({ specId: f.specId, title: f.title }));

  return (
    <section className="grid gap-8 lg:grid-cols-[1fr_280px]">
      <article>
        <div className="mb-6 space-y-1">
          <Link
            href="/backlog"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← Backlog
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {feature.title}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">
            {feature.path}
          </p>
        </div>
        <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
          <ReactMarkdown>{feature.content}</ReactMarkdown>
        </div>
      </article>

      <aside className="space-y-4 lg:border-l lg:pl-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <StatusDot status={feature.status} />
          {statusLabel(feature.status)}
        </div>
        <Separator />
        <FeatureMetaForm
          feature={feature}
          members={members}
          customFields={customFields}
          canEdit={!access || canWrite(access.role)}
        />
        <Separator />
        <FeatureRelations
          specId={feature.specId}
          relations={feature.relations}
          candidates={candidates}
          canEdit={!access || canWrite(access.role)}
        />
        <Separator />
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {feature.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            spec id: {feature.specId}
          </p>
        </div>
      </aside>
    </section>
  );
}
