"use client";

import {
  childLevelKey,
  findLevel,
  parentLevelKey,
  type PropertyType,
  type WorkspaceLevel,
} from "@specboards/core";

import { Badge } from "@/components/ui/badge";
import { CUSTOM_FIELD_PREFIX } from "@/lib/card-fields";
import { pluralLevel } from "@/lib/feature-helpers";
import type { CustomFieldValue, FeatureRecord } from "@/lib/store/types";

/**
 * The lookup tables a card needs to turn field keys into human-readable
 * badges: custom-property labels, member display names, and release names.
 * Shared by the Backlog card ({@link FeatureCard}) and the Roadmap card so both
 * spaces render the same user-selected fields the same way.
 */
export type CardFieldMaps = {
  /** Label for each custom-property key (without the `cf:` prefix). */
  customFieldLabels: Record<string, string>;
  /** Declared type per custom-property key, so `date` values render formatted. */
  customFieldTypes: Record<string, PropertyType>;
  memberNames: Record<string, string>;
  /** Release name by id, for the release badge. */
  releaseNames: Record<string, string>;
  /**
   * The workspace's hierarchy levels, so the child-progress and parent badges
   * can name the levels involved instead of assuming they are called "epic".
   */
  levels: readonly WorkspaceLevel[];
};

/**
 * What a card's children are called, pluralised: "Features" for an Epic in the
 * default hierarchy. Falls back to "items" for a level the hierarchy no longer
 * contains, which is reachable if an admin removes a level while cards still
 * sit at it.
 */
export function childLevelLabel(
  level: string,
  levels: readonly WorkspaceLevel[],
): string {
  const key = childLevelKey(level, levels);
  const label = key ? findLevel(key, levels)?.label : undefined;
  return label ? pluralLevel(label) : "items";
}

/** What a card's parent is called: "Epic" for a Feature in the default set. */
export function parentLevelLabel(
  level: string,
  levels: readonly WorkspaceLevel[],
): string {
  const key = parentLevelKey(level, levels);
  return (key ? findLevel(key, levels)?.label : undefined) ?? "Parent";
}

/**
 * How much of a card's work is finished, as a count of its direct children.
 *
 * Named after the child level rather than the word "epic", which is what this
 * badge used to say at every altitude: on an Epic it counted Features while
 * calling them epics, and on a renamed hierarchy it meant nothing at all. The
 * word "done" is in the visible text because `3/5` on its own reads as an id or
 * a position, not as progress.
 *
 * Shared by the board card and the backlog table so the two cannot drift; the
 * item detail drawer states the same figure in its own layout.
 */
export function ChildProgressBadge({
  feature,
  levels,
}: {
  feature: Pick<FeatureRecord, "level" | "childCount" | "childDoneCount">;
  levels: readonly WorkspaceLevel[];
}) {
  if (feature.childCount === 0) return null;
  const label = childLevelLabel(feature.level, levels);
  return (
    <Badge
      variant="outline"
      size="sm"
      className="tabular-nums"
      title={`${feature.childDoneCount} of ${feature.childCount} ${label} done`}
    >
      {feature.childDoneCount}/{feature.childCount} {label} done
    </Badge>
  );
}

/** That a card sits under a parent, and what that parent is called. */
export function ParentLevelBadge({
  feature,
  levels,
}: {
  feature: Pick<FeatureRecord, "level" | "parentSpecId">;
  levels: readonly WorkspaceLevel[];
}) {
  if (!feature.parentSpecId) return null;
  const label = parentLevelLabel(feature.level, levels);
  return (
    <Badge variant="secondary" size="sm" title={`Parent level: ${label}`}>
      ↳ {label}
    </Badge>
  );
}

function customFieldText(value: CustomFieldValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Format an ISO `YYYY-MM-DD` date value as a short human date (e.g. "Jul 24,
 * 2026"). Non-ISO input is returned unchanged.
 *
 * Assembled from the calendar parts rather than formatted by `Intl`, for two
 * reasons. A date-only value has no instant, so `new Date(string)` would let
 * it shift a day across a timezone. And boards render on the server before
 * they render in the browser: `toLocaleDateString(undefined, …)` reads the
 * locale of whoever runs it, so a server on `en-US` and a viewer on `en-GB`
 * produce "Jul 24, 2026" and "24 Jul 2026" from the same value. React treats
 * that disagreement as a corrupted tree and never attaches the page's event
 * handlers, which turns a formatting difference into a board where nothing is
 * clickable. Fixed English output cannot disagree with itself.
 *
 * A month outside 1-12 is returned unchanged rather than silently rolled over,
 * which is what `new Date(2026, 12, 1)` would have done to "2026-13-01".
 */
function formatCardDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return value;
  return `${month} ${day}, ${m[1]}`;
}

/** Display text for a custom-field value, formatting `date`-typed values. */
export function customFieldDisplay(
  value: CustomFieldValue,
  type: PropertyType | undefined,
): string {
  if (type === "date" && typeof value === "string" && value.trim() !== "") {
    return formatCardDate(value);
  }
  return customFieldText(value);
}

/** Render one card field as a badge (or null when there's nothing to show). */
function renderCardField(
  key: string,
  f: FeatureRecord,
  maps: CardFieldMaps,
): React.ReactNode {
  const { customFieldLabels, customFieldTypes, memberNames, releaseNames } =
    maps;
  switch (key) {
    case "assignee":
      return f.assigneeId ? (
        <Badge key="assignee" variant="secondary" size="sm">
          {memberNames[f.assigneeId] ?? "Assigned"}
        </Badge>
      ) : null;
    case "blocked":
      return f.blockedByCount > 0 ? (
        <Badge
          key="blocked"
          variant="destructive"
          size="sm"
          title={`Blocked by ${f.blockedByCount} feature(s)`}
        >
          Blocked
        </Badge>
      ) : null;
    // `epic` and `sub` are the stored names of these two fields in saved board
    // preferences. They stay as they are, wrong as they now read, because
    // renaming a key silently drops the field from every board that had chosen
    // it; only what the badges say has changed.
    //
    // The emptiness guards are repeated here rather than left to the
    // components: the caller reads a returned node as "this field has something
    // to show", so an element that renders to nothing would still open a badge
    // row on a card with none.
    case "epic":
      return f.childCount > 0 ? (
        <ChildProgressBadge key="epic" feature={f} levels={maps.levels} />
      ) : null;
    case "sub":
      return f.parentSpecId ? (
        <ParentLevelBadge key="sub" feature={f} levels={maps.levels} />
      ) : null;
    case "release":
      return f.releaseId ? (
        <Badge key="release" variant="outline" size="sm">
          {releaseNames[f.releaseId] ?? "Release"}
        </Badge>
      ) : null;
    case "github": {
      const g = f.githubSummary;
      if (g.total === 0) return null;
      if (g.mergedPrs > 0)
        return (
          <Badge
            key="github"
            variant="default"
            size="sm"
            title="Has a merged PR"
          >
            PR merged
          </Badge>
        );
      if (g.openPrs > 0)
        return (
          <Badge
            key="github"
            variant="secondary"
            size="sm"
            title="Has an open PR"
          >
            PR open
          </Badge>
        );
      return (
        <Badge
          key="github"
          variant="outline"
          size="sm"
          title="Linked GitHub artifacts"
        >
          🔗 {g.total}
        </Badge>
      );
    }
    case "tags":
      return f.tags.length > 0
        ? f.tags.map((tag) => (
            <Badge
              key={`tag:${tag}`}
              variant="secondary"
              size="sm"
            >
              {tag}
            </Badge>
          ))
        : null;
    default: {
      if (!key.startsWith(CUSTOM_FIELD_PREFIX)) return null;
      const cfKey = key.slice(CUSTOM_FIELD_PREFIX.length);
      const text = customFieldDisplay(
        f.customFields[cfKey] ?? null,
        customFieldTypes[cfKey],
      );
      if (!text) return null;
      return (
        <Badge key={key} variant="secondary" size="sm">
          {customFieldLabels[cfKey] ?? cfKey}: {text}
        </Badge>
      );
    }
  }
}

/**
 * The badges for a card's chosen `fields`, skipping the `featured` custom field
 * (rendered separately, up top, via {@link featuredBadge}).
 */
export function cardFieldBadges(
  fields: string[],
  featured: string | null,
  f: FeatureRecord,
  maps: CardFieldMaps,
): React.ReactNode[] {
  const featuredKey = featured ? `${CUSTOM_FIELD_PREFIX}${featured}` : null;
  const badges: React.ReactNode[] = [];
  for (const key of fields) {
    if (key === featuredKey) continue;
    const badge = renderCardField(key, f, maps);
    if (badge) badges.push(badge);
  }
  return badges;
}

/**
 * The emphasized "featured" custom-field badge shown above the card title, or
 * null when there's no featured field, it isn't in the chosen `fields`, or the
 * item has no value for it.
 */
export function featuredBadge(
  featured: string | null,
  fields: string[],
  f: FeatureRecord,
  maps: CardFieldMaps,
): React.ReactNode {
  if (!featured) return null;
  if (!fields.includes(`${CUSTOM_FIELD_PREFIX}${featured}`)) return null;
  const value = customFieldDisplay(
    f.customFields[featured] ?? null,
    maps.customFieldTypes[featured],
  );
  if (!value) return null;
  return (
    <Badge variant="secondary" size="sm" className="w-fit">
      {maps.customFieldLabels[featured] ?? featured}: {value}
    </Badge>
  );
}
