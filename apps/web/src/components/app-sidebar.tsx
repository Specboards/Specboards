"use client";

import {
  Compass,
  DraftingCompass,
  Gauge,
  KanbanSquare,
  Lightbulb,
  Map,
  Microscope,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { OrgSwitcher } from "@/components/org-switcher";
import { ProductSwitcher } from "@/components/product-switcher";
import { SidebarProfile } from "@/components/sidebar-profile";
import { GROUP_SLUG_PREFIX } from "@/lib/active-product";
import type { ProductGroupRecord, ProductRecord } from "@/lib/store";
import { useOrgPath, useOrgProductPath, useProductSlug } from "@/lib/use-org";
import { cn } from "@/lib/utils";

/**
 * Routes reached while signed out (auth + onboarding). The app's content pages
 * redirect signed-out visitors to /sign-in server-side, so the rail never
 * paints for them there; we only need to hide it on these public pages.
 */
const HIDDEN_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/setup",
  "/forgot-password",
  "/reset-password",
];

interface NavItem {
  href?: string;
  label: string;
  icon: LucideIcon;
  /** Renders the item disabled with a "Soon" badge (no route yet). */
  soon?: boolean;
  /** Product-scoped area (href is under `/{org}/{product}/…`, not just `/{org}/…`). */
  productScoped?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
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
 * Left navigation rail. Renders on every app page so there's no first-paint
 * layout shift; hidden only on the public auth/onboarding routes. The profile
 * footer handles its own signed-in / local-mode states.
 */
export function AppSidebar({
  orgs = [],
  products = [],
  groups = [],
}: {
  /** The signed-in user's orgs, for the switcher (empty hides it). */
  orgs?: { slug: string; name: string }[];
  /** The active org's products, for the switcher (≤1 hides it). */
  products?: ProductRecord[];
  /** The active org's product groups, for the switcher's group scopes. */
  groups?: ProductGroupRecord[];
}) {
  const pathname = usePathname();
  const orgHref = useOrgPath();
  const productSlug = useProductSlug();

  // A group scope (`~key` product segment) gets a Dashboard area: the group's
  // management roll-up. Hidden otherwise (for a product or "all" the route
  // just redirects to the backlog).
  const navGroups = productSlug.startsWith(GROUP_SLUG_PREFIX)
    ? [
        {
          label: "Track",
          items: [
            {
              href: "/dashboard",
              label: "Dashboard",
              icon: Gauge,
              productScoped: true,
            },
          ],
        },
        ...GROUPS,
      ]
    : GROUPS;

  // Collapsed = icon rail (mark + area icons only). Persisted per browser;
  // starts expanded on first paint (matches SSR), then reflects the stored
  // choice after mount to avoid a hydration mismatch.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("sb:collapsed") === "1");
  }, []);
  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("sb:collapsed", next ? "1" : "0");
      return next;
    });
  }

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen shrink-0 flex-col border-r bg-background transition-[width]",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("py-4", collapsed ? "space-y-2 px-2" : "space-y-3 px-4")}>
        <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between")}>
          <Link
            href={orgHref("/")}
            aria-label="Specboard home"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight"
          >
            <img src="/brand/specboard-mark.png" alt="" className="h-6 w-6" />
            {/* Two-tone wordmark: "Spec" foreground + "board" muted. */}
            {!collapsed ? (
              <span>
                Spec<span className="text-muted-foreground">board</span>
              </span>
            ) : null}
          </Link>
          {!collapsed ? (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <PanelLeftClose className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        {collapsed ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex w-full justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <>
            <OrgSwitcher orgs={orgs} />
            <ProductSwitcher products={products} groups={groups} />
          </>
        )}
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-2">
        {navGroups.map((group, i) => (
          <div key={group.label ?? i} className="space-y-1">
            {group.label && !collapsed ? (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => (
              <NavLink
                key={item.label}
                item={item}
                pathname={pathname}
                collapsed={collapsed}
              />
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t p-2">
        <SidebarProfile collapsed={collapsed} />
      </div>
    </aside>
  );
}

function NavLink({
  item,
  pathname,
  collapsed,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
}) {
  const orgHref = useOrgPath();
  const orgProductHref = useOrgProductPath();
  const Icon = item.icon;
  const base = cn(
    "flex items-center rounded-md text-sm transition-colors",
    collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-3 py-2",
  );

  if (item.soon || !item.href) {
    return (
      <div
        className={cn(base, "cursor-default text-muted-foreground/50")}
        aria-disabled
        title={collapsed ? `${item.label} (soon)` : undefined}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {!collapsed ? (
          <>
            <span className="flex-1">{item.label}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Soon
            </span>
          </>
        ) : null}
      </div>
    );
  }

  const href = item.productScoped ? orgProductHref(item.href) : orgHref(item.href);
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        base,
        active
          ? "bg-secondary font-medium text-secondary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {!collapsed ? <span>{item.label}</span> : null}
    </Link>
  );
}
