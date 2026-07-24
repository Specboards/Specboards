"use client";

import type { PropertyType } from "@specboards/core";

import { Badge } from "@/components/ui/badge";
import { CUSTOM_FIELD_PREFIX } from "@/lib/card-fields";
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
};

export function customFieldText(value: CustomFieldValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Format an ISO `YYYY-MM-DD` date value as a short human date (e.g. "Jul 24,
 * 2026"). Parsed from its calendar parts, not `new Date(string)`, so a
 * date-only value never shifts a day across the local timezone. Non-ISO input
 * is returned unchanged.
 */
function formatCardDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
export function renderCardField(
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
    case "epic":
      return f.childCount > 0 ? (
        <Badge
          key="epic"
          variant="outline"
          size="sm"
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
          size="sm"
          title="Has a parent epic"
        >
          ↳ sub
        </Badge>
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
