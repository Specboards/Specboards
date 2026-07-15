"use client";

import Link from "next/link";

import {
  cardFieldBadges,
  featuredBadge,
  type CardFieldMaps,
} from "@/components/card-field-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { productColorClasses } from "@/lib/product-color";
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
 */
export function FeatureCard({
  feature,
  fields,
  featured,
  customFieldLabels,
  memberNames,
  releaseNames,
  onOpen,
  product,
}: {
  feature: FeatureRecord;
  fields: string[];
  featured: string | null;
  /** Label for each custom-property key (without the `cf:` prefix). */
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  /** Release name by id, for the release badge. */
  releaseNames: Record<string, string>;
  onOpen: () => void;
  /** The owning product, shown as a badge in the cross-product ("All
   * products") view; omitted when the board is scoped to one product. */
  product?: ProductTag;
}) {
  const orgHref = useOrgProductPath();
  const maps: CardFieldMaps = { customFieldLabels, memberNames, releaseNames };
  const badges = cardFieldBadges(fields, featured, feature, maps);
  const featuredEl = featuredBadge(featured, fields, feature, maps);

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-foreground/25"
      onClick={onOpen}
    >
      <CardHeader className="space-y-1 p-3">
        {product ? (
          <Badge
            variant="secondary"
            className={cn(
              "w-fit border-transparent text-[10px]",
              productColorClasses(product).badge,
            )}
          >
            {product.name}
          </Badge>
        ) : null}
        {featuredEl}
        <CardTitle className="text-[0.9375rem]">
          <Link
            href={orgHref(`/backlog/${feature.level}/${feature.specId}`)}
            className="hover:underline"
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
        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">{badges}</div>
        ) : null}
      </CardHeader>
    </Card>
  );
}
