"use client";

import Link from "next/link";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

import { AssistantPanel } from "@/components/assistant-panel";
import { CreateSpecButton } from "@/components/create-spec-button";
import {
  DetailSection,
  openDetailSection,
} from "@/components/detail-section";
import { FeatureComments } from "@/components/feature-comments";
import { FeatureDetailsEditor } from "@/components/feature-details-editor";
import { FeatureGithubLinks } from "@/components/feature-github-links";
import { FeatureParentSelect } from "@/components/feature-parent-select";
import { FeatureRelations } from "@/components/feature-relations";
import { GateChecklist } from "@/components/gate-checklist";
import { GenerateChildButton } from "@/components/generate-child-button";
import { ItemGoals } from "@/components/item-goals";
import { ItemProperties } from "@/components/item-properties";
import { ItemTitle } from "@/components/item-title";
import { ItemHistory } from "@/components/item-history";
import { SpecBodyEditor } from "@/components/spec-body-editor";
import { SpecPendingChange } from "@/components/spec-pending-change";
import { StatusDot } from "@/components/status-dot";
import { WorkItemDelete } from "@/components/work-item-controls";
import { Badge } from "@/components/ui/badge";
import { pluralLevel, statusLabel } from "@/lib/feature-helpers";
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
  onSpecSaved,
}: {
  data: ItemDetailData;
  /** "page" is the full-screen route; "flyout" is the in-context drawer. */
  variant: "page" | "flyout";
  /**
   * Called after any write that goes through git: a spec body committed, a spec
   * attached, a child spec created. The full page re-renders from the refreshed
   * cache on its own (`router.refresh()`), but the flyout holds its item in
   * local state and has to re-read it, or it would keep showing the item as it
   * was before the commit.
   */
  onSpecSaved?: () => void;
}) {
  const {
    feature,
    members,
    properties,
    releases,
    cycles,
    goals,
    linkableGoals,
    workflow,
    stageGates,
    completedGateIds,
    canEdit,
    canEditSpec,
    canAttachSpec,
    canCreateChildSpec,
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

  /**
   * A description written from outside the editor, which today means an
   * accepted assistant proposal.
   *
   * The DB-native editor deliberately never remounts on its own saves (see
   * FeatureDetailsEditor), so it keeps whatever body it mounted with. After an
   * accept that body is stale, and the next keystroke autosaves it back over
   * the change: a silent revert of the thing the user just approved. Bumping
   * `rev` remounts it, and seeding from `body` rather than waiting for
   * `feature.content` to come back around means there is no window where it is
   * mounted holding the old text.
   */
  const [applied, setApplied] = useState<{ body: string; rev: number } | null>(
    null,
  );

  // Two editable bodies with two different destinations. A DB-native card's
  // body is a database column, so it autosaves. A spec's body is a file in git,
  // so it commits, and the editor for it says so rather than pretending the two
  // are the same thing (`canEditSpec` also covers having a file to write to and
  // a deployment that can reach the repo).
  const editableBody = feature.isDbNative && canEdit;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <Badge
          variant="outline"
          size="sm"
          className="uppercase tracking-wide"
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
        cycles={cycles}
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
        {/* Above the body on purpose: it explains why the text underneath is
            not the change someone just made, so reading it afterwards is too
            late to stop them concluding the editor lost their work. */}
        <SpecPendingChange links={feature.githubLinks} />
        {editableBody ? (
          <FeatureDetailsEditor
            key={applied ? `applied-${applied.rev}` : "own"}
            specId={feature.specId}
            initial={applied?.body ?? feature.content}
            minHeightClass="min-h-[15rem]"
          />
        ) : canEditSpec ? (
          <SpecBodyEditor
            specId={feature.specId}
            path={feature.path}
            initial={feature.content}
            blobSha={feature.blobSha}
            writeMode={data.specWriteMode}
            minHeightClass="min-h-[15rem]"
            onSaved={onSpecSaved}
          />
        ) : feature.content.trim() === "" ? (
          <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            {childLabel
              ? `This ${levelLabel.toLowerCase()} groups work and has no body of its own. Add ${pluralLevel(childLabel.toLowerCase())} beneath it to build it out.`
              : "No details yet."}
          </div>
        ) : (
          <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
            <ReactMarkdown>{feature.content}</ReactMarkdown>
          </div>
        )}
        {/* Below the body rather than beside the heading, so the expanded form
            has the full column to open into. Only a leaf card tracked in the
            app can take a spec; everywhere else the server would refuse. */}
        {canAttachSpec ? (
          <CreateSpecButton
            target={{
              kind: "attach",
              workItemId: feature.specId,
              itemTitle: feature.title,
            }}
            repos={data.repos}
            onCreated={onSpecSaved}
          />
        ) : canCreateChildSpec && childLabel ? (
          // Explain the absence rather than leaving it a mystery. On a
          // grouping level there is no "Attach a spec" and no stated reason,
          // so the neighbouring "New <leaf>" control reads as the way to
          // document THIS card. It is not, and finding that out means reading
          // a committed file.
          //
          // The control it points at lives in Relationships, which is
          // collapsed by default: saying "below" would name something the
          // reader cannot see, so the phrase opens the section instead.
          <p className="text-2xs text-muted-foreground">
            Specs live on {pluralLevel(childLabel.toLowerCase())}. To document
            this {levelLabel.toLowerCase()},{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => openDetailSection("relationships")}
            >
              break it down into one
            </button>
            .
          </p>
        ) : null}
      </div>

      {/* Directly under the body, because that is what it is for: help with
          this definition, not a general chat that happens to be on the page.
          Collapsed by default so it sits beside the editor rather than
          competing with it, and because a panel that fetches on open costs
          nothing to the majority of visits that are not asking anything. */}
      <DetailSection id="assistant" title="Assistant" defaultCollapsed>
        <AssistantPanel
          subject={{ kind: "item", specId: feature.specId }}
          onApplied={(body) => {
            setApplied((prev) => ({ body, rev: (prev?.rev ?? 0) + 1 }));
            // The flyout holds its item in local state, so it has to re-read
            // for everything else on the card (history, the board behind it).
            onSpecSaved?.();
          }}
        />
      </DetailSection>

      {/* Why this work exists. Sits above the containment relationships below,
          because a goal is a different kind of link: many-to-many, measured,
          and reachable from any level. */}
      <DetailSection id="goals" title="Goals" defaultCollapsed>
        <ItemGoals
          specId={feature.specId}
          goals={goals}
          linkable={linkableGoals}
          canEdit={canEdit}
        />
      </DetailSection>

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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {feature.children.length > 0
                    ? `${pluralLevel(childLabel)} · ${feature.childDoneCount}/${feature.childCount} done`
                    : `No ${pluralLevel(childLabel.toLowerCase())} yet.`}
                </p>
                {canEdit ? (
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                    <GenerateChildButton
                      parentSpecId={feature.specId}
                      parentTitle={feature.title}
                      childLevelKey={childKey}
                      childLevelLabel={childLabel}
                      productId={feature.productId}
                      workflow={workflow}
                      members={members}
                    />
                    {/* Two neighbouring ways to add a child, because they are
                        two different things: a tracked card, or a card with a
                        document in the repo behind it. */}
                    {canCreateChildSpec ? (
                      <CreateSpecButton
                        target={{
                          kind: "child",
                          parentSpecId: feature.specId,
                          parentTitle: feature.title,
                          childLevelLabel: childLabel,
                        }}
                        repos={data.repos}
                        templates={data.specTemplates}
                        // The flyout holds its item in local state, so without
                        // this it keeps reporting "no items yet" beside the
                        // child that was just created.
                        onCreated={onSpecSaved}
                      />
                    ) : null}
                  </div>
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
          repos={data.repos}
        />
      </DetailSection>

      {/* Collapsed by default: most people opening an item are not asking what
          happened to it, and the panel fetches only when it is opened. */}
      <DetailSection id="history" title="History" defaultCollapsed>
        <ItemHistory
          specId={feature.specId}
          isSpecBacked={!feature.isDbNative}
          context={{
            workflow,
            members: members.map((m) => ({ userId: m.userId, name: m.name })),
            releases: releases.map((r) => ({ id: r.id, name: r.name })),
            cycles: cycles.map((c) => ({ id: c.id, name: c.name })),
          }}
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

      {canEdit ? (
        <WorkItemDelete
          specId={feature.specId}
          levelLabel={levelLabel}
          // `path` is set only when a spec is attached; passing it turns the
          // delete into "item + its spec file" and says so in the confirm.
          specPath={feature.isDbNative ? null : feature.path || null}
          redirectOnDelete={variant === "page"}
        />
      ) : null}
    </div>
  );
}
