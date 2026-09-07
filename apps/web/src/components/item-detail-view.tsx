"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";

import { AssistantPanel } from "@/components/assistant-panel";
import { CreateSpecButton } from "@/components/create-spec-button";
import { DescriptionBlock } from "@/components/description-block";
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
import { StatusDot } from "@/components/status-dot";
import { WorkItemDelete } from "@/components/work-item-controls";
import { Badge } from "@/components/ui/badge";
import { pluralLevel, statusLabel } from "@/lib/feature-helpers";
import type { ItemDetailData } from "@/lib/item-detail";
import { useOrgProductPath } from "@/lib/use-org";
import { useResetOnChange } from "@/lib/use-reset-on-change";

/**
 * The single source of truth for how an item's detail is laid out: title,
 * Notion-style property block, editable body, then Assistant, Relationships
 * (parent, children, goals, relations), Integrations, Comments and History.
 * Both the full item page and the resizable flyout render this, so the two
 * views are identical by construction.
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

  /**
   * The body as it currently stands, for the folded preview and for reseeding
   * the editor when the fold opens again.
   *
   * `feature.content` is what the page loaded with, and the DB-native editor
   * deliberately never remounts on its own saves, so after any typing it is the
   * wrong text. `router.refresh()` catches up eventually; the preview would
   * show the stale version until it did.
   */
  const [savedBody, setSavedBody] = useState<string | null>(null);
  /** True while either body holds something the author has not committed. */
  const [bodyDirty, setBodyDirty] = useState(false);
  const bodyText = savedBody ?? applied?.body ?? feature.content;

  // Stable identities: SpecBodyEditor reports its state from an effect that
  // depends on the callback, so a new function every render would re-run it
  // every render.
  const onBodyDirty = useCallback((dirty: boolean) => setBodyDirty(dirty), []);
  const onBodySaved = useCallback((body: string) => setSavedBody(body), []);

  // The flyout reuses this component for whatever card you click next rather
  // than remounting it, so every piece of body state above has to be dropped
  // when the item changes. Without it the editor seeds the previous item's
  // text and autosaves it onto this one, which is not a stale render but a
  // write of the wrong body to the wrong card.
  useResetOnChange(feature.specId, () => {
    setApplied(null);
    setSavedBody(null);
    setBodyDirty(false);
  });

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
        tags={data.tags}
      />

      {/* Exit-criteria checklist for the stage this item currently sits in.
          Keyed by specId + status so its local checked-state re-seeds when the
          view is reused for another item or after the stage changes. */}
      <GateChecklist
        key={`${feature.specId}:${feature.status}`}
        specId={feature.specId}
        stageLabel={statusLabel(feature.status, workflow)}
        gates={stageGates}
        canEdit={canEdit}
      />

      <hr className="border-border/60" />

      {/* Description / body */}
      <DescriptionBlock
        itemId={feature.specId}
        body={bodyText}
        links={feature.githubLinks}
        dirty={bodyDirty}
      >
        {editableBody ? (
          <FeatureDetailsEditor
            key={applied ? `applied-${applied.rev}` : "own"}
            specId={feature.specId}
            initial={bodyText}
            minHeightClass="min-h-[15rem]"
            onDirtyChange={onBodyDirty}
            onSaved={onBodySaved}
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
            onDirtyChange={onBodyDirty}
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
      </DescriptionBlock>

      {/* Outside the fold. Below the body rather than beside the heading, so
          the expanded form has the full column to open into, but folding the
          description away must not take "Attach a spec" with it: the reason to
          fold a long body is to reach the controls under it. Only a leaf card
          tracked in the app can take a spec; everywhere else the server would
          refuse. */}
      <div className="space-y-2">
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
            // The accepted proposal is now the newest text; anything this
            // view remembered saving is older than it.
            setSavedBody(null);
            // The flyout holds its item in local state, so it has to re-read
            // for everything else on the card (history, the board behind it).
            onSpecSaved?.();
          }}
        />
      </DetailSection>

      {/* Every link this item has, in one section: the hierarchy above and
          below it, the goals it ladders up to, and its lateral relations.
          Goals used to be a section of their own. It is a different kind of
          link (many-to-many, measured, reachable from any level) but it is
          still a link between two records in this model, and splitting it out
          meant a reader looking for "what is this connected to" had two places
          to look. Integrations deliberately stays separate: a GitHub PR is a
          pointer at another system, not a record here, and folding it in would
          make this section the whole card. */}
      <DetailSection id="relationships" title="Relationships" defaultCollapsed>
        <div className="space-y-5">
          {parentKey && parentLevelLabel ? (
            <FeatureParentSelect
              specId={feature.specId}
              parentSpecId={feature.parentSpecId}
              parentTitle={feature.parentTitle}
              parentLevelKey={parentKey}
              parentLabel={parentLevelLabel}
              candidates={parentCandidates}
              canEdit={canEdit}
            />
          ) : null}

          {childKey && childLabel ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* Always a heading, with the empty case as a subordinate line
                    below it rather than in place of it. The old version put
                    "No work items yet." where the heading goes, which made a
                    negative sentence the most prominent text in a section that
                    might well be showing a parent and a goal. */}
                <p className="text-xs font-medium text-muted-foreground">
                  {pluralLevel(childLabel)}
                  {feature.children.length > 0
                    ? ` · ${feature.childDoneCount}/${feature.childCount} done`
                    : ""}
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
              {feature.children.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No {pluralLevel(childLabel.toLowerCase())} yet.
                </p>
              ) : null}
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

          {/* After the hierarchy and before the lateral relations: the
              parent/child pair is what people open this section for, and
              putting goals below them keeps the child controls exactly where
              `openDetailSection("relationships")` used to land them. */}
          <ItemGoals
            specId={feature.specId}
            goals={goals}
            linkable={linkableGoals}
            canEdit={canEdit}
          />

          <FeatureRelations
            specId={feature.specId}
            relations={feature.relations}
            candidates={relationCandidates}
            canEdit={canEdit}
            currentReleaseId={feature.releaseId}
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

      {/* The only section on the card that opens by default, because a comment
          is usually addressed to someone and waiting to be read. That is also
          why it sits above History rather than below it: an always-open
          section under an always-shut one reads as an afterthought. */}
      <DetailSection id="comments" title="Comments">
        <FeatureComments
          specId={feature.specId}
          currentUserId={currentUserId}
          members={members
            .filter((m) => !m.deactivatedAt)
            .map((m) => ({ userId: m.userId, name: m.name }))}
        />
      </DetailSection>

      {/* Last of the sections, and collapsed by default: most people opening an
          item are not asking what happened to it, and the panel fetches only
          when it is opened. Anything added to the card goes above this, not
          below. */}
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
