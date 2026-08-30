"use client";

import Link from "next/link";

import {
  cardFieldBadges,
  featuredBadge,
  type CardFieldMaps,
} from "@/components/card-field-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { PropertyType, WorkspaceLevel } from "@specboards/core";

import { formatRiceScore } from "@/lib/feature-helpers";
import { productBadge } from "@/lib/product-color";
import type { FeatureRecord } from "@/lib/store/types";
import { useOrgProductPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";

/** A product's identity for the attribution badge shown in cross-product views. */
export type ProductTag = { name: string; key: string; color: string | null };

/** Stop a pointer/click on an interactive control from starting a card drag. */
function stop(e: React.PointerEvent | React.MouseEvent) {
  e.stopPropagation();
}

/** True when a click carries a modifier that should open a link in a new tab. */
function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1;
}

/**
 * Presentational board card. Renders only the fields the user has chosen
 * (`fields`), emphasizing `featured`. Drag wiring lives in the board client;
 * this component just handles the title link. The card carries no status
 * control: the column it sits in already shows the stage, and dragging between
 * columns is how the stage changes.
 *
 * Where the card can be dragged, only the title opens it: the body is the grab
 * handle (the Roadmap card works the same way). A whole-card click target made
 * the "open" zone far bigger than the name it looked like, so a grab that
 * started a few pixels short of the drag threshold opened the drawer instead.
 */
export function FeatureCard({
  feature,
  fields,
  featured,
  customFieldLabels,
  customFieldTypes,
  memberNames,
  releaseNames,
  levels,
  onOpen,
  clickToOpen = false,
  product,
}: {
  feature: FeatureRecord;
  fields: string[];
  featured: string | null;
  /** Label for each custom-property key (without the `cf:` prefix). */
  customFieldLabels: Record<string, string>;
  /** Declared type per custom-property key, so `date` values render formatted. */
  customFieldTypes: Record<string, PropertyType>;
  memberNames: Record<string, string>;
  /** Release name by id, for the release badge. */
  releaseNames: Record<string, string>;
  /** The workspace's hierarchy levels, so the child-progress and parent badges
   * can name the levels rather than assume the default ones. */
  levels: readonly WorkspaceLevel[];
  onOpen: () => void;
  /** Make the whole card a click target for opening it. Only set where drag is
   * off (below md), so a tap anywhere still opens the item; wherever the card
   * can be dragged, the title is the open affordance and the body is the
   * handle. */
  clickToOpen?: boolean;
  /** The owning product, shown as a badge in the cross-product ("All
   * products") view; omitted when the board is scoped to one product. */
  product?: ProductTag;
}) {
  const orgHref = useOrgProductPath();
  const maps: CardFieldMaps = {
    customFieldLabels,
    customFieldTypes,
    memberNames,
    releaseNames,
    levels,
  };
  const badges = cardFieldBadges(fields, featured, feature, maps);
  const featuredEl = featuredBadge(featured, fields, feature, maps);

  return (
    <Card
      className={cn(
        "transition-colors hover:border-foreground/25",
        clickToOpen && "cursor-pointer",
      )}
      onClick={clickToOpen ? onOpen : undefined}
    >
      <CardHeader className="space-y-1 p-3">
        {product ? (
          <Badge
            variant="secondary"
            size="sm"
            className={cn(
              "w-fit border-transparent",
              productBadge(product).className,
            )}
            style={productBadge(product).style}
          >
            {product.name}
          </Badge>
        ) : null}
        {featuredEl}
        <CardTitle className="text-[0.9375rem]">
          {/* The card's open affordance. `stop` on pointerdown keeps the title
              out of the drag handle, so a press here is unambiguously a click
              and a press anywhere else on the card is unambiguously a grab. */}
          <Link
            href={orgHref(`/backlog/${feature.level}/${feature.specId}`)}
            className="cursor-pointer hover:underline"
            onPointerDown={stop}
            onClick={(e) => {
              e.stopPropagation();
              // Plain click opens the in-context panel; a modified click still
              // follows the href so the full page can open in a new tab.
              if (isModifiedClick(e)) return;
              e.preventDefault();
              onOpen();
            }}
          >
            {feature.title}
          </Link>
        </CardTitle>
        {badges.length > 0 || feature.riceScore !== null ? (
          <div className="flex flex-wrap items-center gap-1">
            {badges}
            {feature.riceScore !== null ? (
              <Badge
                variant="outline"
                size="sm"
                className="tabular-nums"
                title="RICE score"
              >
                RICE {formatRiceScore(feature.riceScore)}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
    </Card>
  );
}
