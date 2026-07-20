"use client";

import Link from "next/link";
import ReactMarkdown from "react-markdown";

import { DetailSection } from "@/components/detail-section";
import { FeatureComments } from "@/components/feature-comments";
import { FeatureDetailsEditor } from "@/components/feature-details-editor";
import { FeatureGithubLinks } from "@/components/feature-github-links";
import { FeatureParentSelect } from "@/components/feature-parent-select";
import { FeatureRelations } from "@/components/feature-relations";
import { GateChecklist } from "@/components/gate-checklist";
import { GenerateChildButton } from "@/components/generate-child-button";
import { ItemProperties } from "@/components/item-properties";
import { ItemTitle } from "@/components/item-title";
import { StatusDot } from "@/components/status-dot";
import { WorkItemDelete } from "@/components/work-item-controls";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/feature-helpers";
import type { ItemDetailData } from "@/lib/item-detail";
import { useOrgProductPath } from "@/lib/use-org";

/**
 * The single source of truth for how an item's detail is laid out: title,
 * Notion-style property block, editable body, then Relationships and
 * Integrations. Both the full item page and the resizable flyout render this,
 * so the two views are identical by construction.
 */
export function ItemDetailView({
  data,
  variant,
}: {
  data: ItemDetailData;
  /** "page" is the full-screen route; "flyout" is the in-context drawer. */
  variant: "page" | "flyout";
}) {
  const {
    feature,
    members,
    properties,
    releases,
    workflow,
    stageGates,
    completedGateIds,
    canEdit,
    currentUserId,
    availableFields,
    levelLabel,
    parentKey,
    parentLevelLabel,
    childKey,
    childLabel,
    parentCandidates,
    relationCandidates,
  } = data;
  const orgHref = useOrgProductPath();

  // DB-native items' bodies live inline and are editable; spec-backed bodies
  // come from git and render read-only here.
  const editableBody = feature.isDbNative && canEdit;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Badge
          variant="outline"
          className="text-[10px] uppercase tracking-wide"
        >
          {levelLabel}
        </Badge>
        <ItemTitle
          specId={feature.specId}
          title={feature.title}
          canEdit={canEdit && feature.isDbNative}
          className={variant === "flyout" ? "text-xl" : "text-2xl"}
        />
        {feature.path ? (
          <p className="font-mono text-xs text-muted-foreground">
            {feature.path}
          </p>
        ) : null}
      </header>

      {/* Notion-style properties, ungrouped, right below the title. */}
      <ItemProperties
        feature={feature}
        members={members}
        properties={properties}
        releases={releases}
        workflow={workflow}
        canEdit={canEdit}
        availableFields={availableFields}
      />

      {/* Exit-criteria checklist for the stage this item currently sits in.
          Keyed by specId + status so its local checked-state re-seeds when the
          view is reused for another item or after the stage changes. */}
      <GateChecklist
        key={`${feature.specId}:${feature.status}`}
        specId={feature.specId}
        stageLabel={statusLabel(feature.status, workflow)}
        gates={stageGates}
        completedGateIds={completedGateIds}
        canEdit={canEdit}
      />

      <hr className="border-border/60" />

      {/* Description / body */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Description</h2>
        {editableBody ? (
          <FeatureDetailsEditor
            specId={feature.specId}
            initial={feature.content}
            minHeightClass="min-h-[15rem]"
          />
        ) : feature.content.trim() === "" ? (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            {childLabel
              ? `This ${levelLabel.toLowerCase()} groups work and has no body of its own. Add ${childLabel.toLowerCase()} items beneath it to build it out.`
              : "No details yet."}
          </div>
        ) : (
          <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
            <ReactMarkdown>{feature.content}</ReactMarkdown>
          </div>
        )}
      </div>

      <DetailSection id="relationships" title="Relationships" defaultCollapsed>
        <div className="space-y-5">
          {parentKey && parentLevelLabel ? (
            <div className="space-y-2">
              <FeatureParentSelect
                specId={feature.specId}
                parentSpecId={feature.parentSpecId}
                parentLabel={parentLevelLabel}
                candidates={parentCandidates}
                canEdit={canEdit}
              />
              {feature.parentSpecId ? (
                <p className="text-sm">
                  <span className="text-muted-foreground">Parent: </span>
                  <Link
                    href={orgHref(
                      `/backlog/${parentKey}/${feature.parentSpecId}`,
                    )}
                    className="text-link hover:underline"
                  >
                    {feature.parentTitle ?? feature.parentSpecId}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}

          {childKey && childLabel ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {feature.children.length > 0
                    ? `${childLabel} items · ${feature.childDoneCount}/${feature.childCount} done`
                    : `No ${childLabel.toLowerCase()} items yet.`}
                </p>
                {canEdit ? (
                  <GenerateChildButton
                    parentSpecId={feature.specId}
                    parentTitle={feature.title}
                    childLevelKey={childKey}
                    childLevelLabel={childLabel}
                    productId={feature.productId}
                    workflow={workflow}
                    members={members}
                  />
                ) : null}
              </div>
              {feature.children.map((c) => (
                <div key={c.specId} className="flex items-center gap-2 text-sm">
                  <StatusDot status={c.status} />
                  <Link
                    href={orgHref(`/backlog/${childKey}/${c.specId}`)}
                    className="flex-1 truncate text-link hover:underline"
                    title={c.title}
                  >
                    {c.title}
                  </Link>
                </div>
              ))}
            </div>
          ) : null}

          <FeatureRelations
            specId={feature.specId}
            relations={feature.relations}
            candidates={relationCandidates}
            canEdit={canEdit}
          />
        </div>
      </DetailSection>

      <DetailSection id="integrations" title="Integrations" defaultCollapsed>
        <FeatureGithubLinks
          specId={feature.specId}
          links={feature.githubLinks}
          canEdit={canEdit}
        />
      </DetailSection>

      <DetailSection id="comments" title="Comments">
        <FeatureComments
          specId={feature.specId}
          currentUserId={currentUserId}
          members={members
            .filter((m) => !m.deactivatedAt)
            .map((m) => ({ userId: m.userId, name: m.name }))}
        />
      </DetailSection>

      {feature.isDbNative && canEdit ? (
        <WorkItemDelete
          specId={feature.specId}
          levelLabel={levelLabel}
          redirectOnDelete={variant === "page"}
        />
      ) : null}
    </div>
  );
}
