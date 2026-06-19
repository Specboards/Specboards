"use client";

import Link from "next/link";

import type { StatusWorkflow } from "@specboard/core";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusSelect } from "@/components/status-select";
import { CUSTOM_FIELD_PREFIX } from "@/lib/card-fields";
import { priorityLabel } from "@/lib/feature-helpers";
import type { CustomFieldValue, FeatureRecord } from "@/lib/store/types";
import { useOrgProductPath } from "@/lib/use-org";

/** Stop a pointer/click on an interactive control from starting a card drag. */
function stop(e: React.PointerEvent | React.MouseEvent) {
  e.stopPropagation();
}

function customFieldText(value: CustomFieldValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Presentational board card. Renders only the fields the user has chosen
 * (`fields`), emphasizing `featured`. Drag wiring lives in the board client;
 * this component just handles its own interactive bits (title link, status).
 */
export function FeatureCard({
  feature,
  fields,
  featured,
  customFieldLabels,
  memberNames,
  workflow,
  canEdit,
  onOpen,
}: {
  feature: FeatureRecord;
  fields: string[];
  featured: string | null;
  /** Label for each custom-field key (without the `cf:` prefix). */
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  workflow?: StatusWorkflow;
  canEdit: boolean;
  onOpen: () => void;
}) {
  const orgHref = useOrgProductPath();
  const show = new Set(fields);
  const featuredKey = featured ? `${CUSTOM_FIELD_PREFIX}${featured}` : null;

  const badges: React.ReactNode[] = [];
  for (const key of fields) {
    if (key === featuredKey) continue; // rendered separately, up top
    const badge = renderField(key, feature, customFieldLabels, memberNames);
    if (badge) badges.push(badge);
  }

  const featuredValue =
    featured && show.has(`${CUSTOM_FIELD_PREFIX}${featured}`)
      ? customFieldText(feature.customFields[featured] ?? null)
      : "";

  return (
    <Card
      className="cursor-pointer rounded-lg shadow-none transition-colors hover:border-foreground/20"
      onClick={onOpen}
    >
      <CardHeader className="space-y-1 p-3">
        {featuredValue ? (
          <Badge variant="secondary" className="w-fit text-[10px]">
            {customFieldLabels[featured!] ?? featured}: {featuredValue}
          </Badge>
        ) : null}
        <CardTitle className="text-sm">
          <Link
            href={orgHref(`/backlog/${feature.specId}`)}
            className="hover:underline"
            onPointerDown={stop}
            onClick={stop}
          >
            {feature.title}
          </Link>
        </CardTitle>
        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">{badges}</div>
        ) : null}
      </CardHeader>
      <CardContent className="p-3 pt-0" onPointerDown={stop} onClick={stop}>
        <StatusSelect
          specId={feature.specId}
          status={feature.status}
          className="h-7 text-xs"
          canEdit={canEdit}
          workflow={workflow}
        />
      </CardContent>
    </Card>
  );
}

/** Render one card field as a badge (or null when there's nothing to show). */
function renderField(
  key: string,
  f: FeatureRecord,
  customFieldLabels: Record<string, string>,
  memberNames: Record<string, string>,
): React.ReactNode {
  switch (key) {
    case "priority":
      return (
        <Badge key="priority" variant="outline" className="font-mono text-[10px]">
          {priorityLabel(f.priority)}
        </Badge>
      );
    case "estimate":
      return f.rolledEstimate !== null ? (
        <Badge
          key="estimate"
          variant="outline"
          className="font-mono text-[10px]"
          title={f.childCount > 0 ? "Estimate (rolled up from children)" : "Estimate"}
        >
          {f.childCount > 0 ? "Σ" : ""}
          {f.rolledEstimate}
        </Badge>
      ) : null;
    case "assignee":
      return f.assigneeId ? (
        <Badge key="assignee" variant="secondary" className="text-[10px]">
          {memberNames[f.assigneeId] ?? "Assigned"}
        </Badge>
      ) : null;
    case "blocked":
      return f.blockedByCount > 0 ? (
        <Badge
          key="blocked"
          variant="destructive"
          className="text-[10px]"
          title={`Blocked by ${f.blockedByCount} feature(s)`}
        >
          Blocked
        </Badge>
      ) : null;
    case "epic":
      return f.childCount > 0 ? (
        <Badge
          key="epic"
          variant="outline"
          className="text-[10px]"
          title={`${f.childDoneCount} of ${f.childCount} children done`}
        >
          epic {f.childDoneCount}/{f.childCount}
        </Badge>
      ) : null;
    case "sub":
      return f.parentSpecId ? (
        <Badge
          key="sub"
          variant="secondary"
          className="text-[10px]"
          title="Has a parent epic"
        >
          ↳ sub
        </Badge>
      ) : null;
    case "quarter":
      return f.roadmapQuarter ? (
        <Badge key="quarter" variant="outline" className="text-[10px]">
          {f.roadmapQuarter}
        </Badge>
      ) : null;
    case "github": {
      const g = f.githubSummary;
      if (g.total === 0) return null;
      if (g.mergedPrs > 0)
        return (
          <Badge key="github" variant="default" className="text-[10px]" title="Has a merged PR">
            PR merged
          </Badge>
        );
      if (g.openPrs > 0)
        return (
          <Badge key="github" variant="secondary" className="text-[10px]" title="Has an open PR">
            PR open
          </Badge>
        );
      return (
        <Badge key="github" variant="outline" className="text-[10px]" title="Linked GitHub artifacts">
          🔗 {g.total}
        </Badge>
      );
    }
    case "tags":
      return f.tags.length > 0
        ? f.tags.map((tag) => (
            <Badge key={`tag:${tag}`} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))
        : null;
    default: {
      if (!key.startsWith(CUSTOM_FIELD_PREFIX)) return null;
      const cfKey = key.slice(CUSTOM_FIELD_PREFIX.length);
      const text = customFieldText(f.customFields[cfKey] ?? null);
      if (!text) return null;
      return (
        <Badge key={key} variant="secondary" className="text-[10px]">
          {customFieldLabels[cfKey] ?? cfKey}: {text}
        </Badge>
      );
    }
  }
}
