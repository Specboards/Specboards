"use client";

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
  memberNames: Record<string, string>;
  /** Release name by id, for the release badge. */
  releaseNames: Record<string, string>;
};

export function customFieldText(value: CustomFieldValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Render one card field as a badge (or null when there's nothing to show). */
export function renderCardField(
  key: string,
  f: FeatureRecord,
  maps: CardFieldMaps,
): React.ReactNode {
  const { customFieldLabels, memberNames, releaseNames } = maps;
  switch (key) {
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
    case "release":
      return f.releaseId ? (
        <Badge key="release" variant="outline" className="text-[10px]">
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
            className="text-[10px]"
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
            className="text-[10px]"
            title="Has an open PR"
          >
            PR open
          </Badge>
        );
      return (
        <Badge
          key="github"
          variant="outline"
          className="text-[10px]"
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
              className="text-[10px]"
            >
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
  const value = customFieldText(f.customFields[featured] ?? null);
  if (!value) return null;
  return (
    <Badge variant="secondary" className="w-fit text-[10px]">
      {maps.customFieldLabels[featured] ?? featured}: {value}
    </Badge>
  );
}
