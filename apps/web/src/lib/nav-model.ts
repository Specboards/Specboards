import {
  Compass,
  DraftingCompass,
  Gauge,
  KanbanSquare,
  Lightbulb,
  Map,
  Microscope,
  Settings,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { GROUP_SLUG_PREFIX } from "@/lib/active-product";

/**
 * The app's primary navigation model, shared by the sidebar rail and the Cmd-K
 * command palette so the two never drift. Each item is a destination area;
 * `soon` items have no route yet.
 */
export interface NavItem {
  href?: string;
  label: string;
  icon: LucideIcon;
  /** Renders disabled with a "Soon" badge (no route yet). */
  soon?: boolean;
  /** Product-scoped area (href is under `/{org}/{product}/…`, not `/{org}/…`). */
  productScoped?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export const GROUPS: NavGroup[] = [
  {
    label: "Plan",
    items: [
      { href: "/strategy", label: "Strategy", icon: Compass, productScoped: true },
      { href: "/research", label: "Research", icon: Microscope, productScoped: true },
      {
        href: "/architecture",
        label: "Architecture",
        icon: DraftingCompass,
        productScoped: true,
      },
    ],
  },
  {
    label: "Build",
    items: [
      { href: "/ideas", label: "Ideas", icon: Lightbulb, productScoped: true },
      { href: "/backlog", label: "Backlog", icon: KanbanSquare, productScoped: true },
    ],
  },
  {
    label: "Ship",
    items: [
      { href: "/roadmap", label: "Roadmap", icon: Map, productScoped: true },
      { label: "Adoption", icon: TrendingUp, soon: true },
    ],
  },
  {
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

/**
 * The nav groups to show for the active product slug. A group scope (`~key`
 * segment) gets a Dashboard area (the group's management roll-up) prepended;
 * every other scope shows the base groups.
 */
export function buildNavGroups(productSlug: string): NavGroup[] {
  if (!productSlug.startsWith(GROUP_SLUG_PREFIX)) return GROUPS;
  return [
    {
      label: "Track",
      items: [
        { href: "/dashboard", label: "Dashboard", icon: Gauge, productScoped: true },
      ],
    },
    ...GROUPS,
  ];
}

/**
 * Routes reached while signed out (auth + onboarding). The sidebar and command
 * palette both stay hidden on these so neither paints for signed-out visitors.
 */
export const HIDDEN_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/setup",
  "/forgot-password",
  "/reset-password",
];
