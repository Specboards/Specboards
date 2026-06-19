"use client";

import {
  Compass,
  KanbanSquare,
  Lightbulb,
  Map,
  Microscope,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { OrgSwitcher } from "@/components/org-switcher";
import { ProductSwitcher } from "@/components/product-switcher";
import { SidebarProfile } from "@/components/sidebar-profile";
import type { ProductRecord } from "@/lib/store";
import { useOrgPath, useOrgProductPath } from "@/lib/use-org";
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
    items: [
      { label: "Strategy", icon: Compass, soon: true },
      { label: "Research", icon: Microscope, soon: true },
    ],
  },
  {
    label: "Work",
    items: [
      { label: "Ideas", icon: Lightbulb, soon: true },
      { href: "/backlog", label: "Backlog", icon: KanbanSquare, productScoped: true },
      { href: "/roadmap", label: "Roadmap", icon: Map, productScoped: true },
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
}: {
  /** The signed-in user's orgs, for the switcher (empty hides it). */
  orgs?: { slug: string; name: string }[];
  /** The active org's products, for the switcher (≤1 hides it). */
  products?: ProductRecord[];
}) {
  const pathname = usePathname();
  const orgHref = useOrgPath();

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-background">
      <div className="space-y-3 px-4 py-4">
        <Link
          href={orgHref("/")}
          className="block text-sm font-semibold tracking-tight"
        >
          SpecBoard
        </Link>
        <OrgSwitcher orgs={orgs} />
        <ProductSwitcher products={products} />
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-2">
        {GROUPS.map((group, i) => (
          <div key={group.label ?? i} className="space-y-1">
            {group.label ? (
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => (
              <NavLink key={item.label} item={item} pathname={pathname} />
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t p-2">
        <SidebarProfile />
      </div>
    </aside>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const orgHref = useOrgPath();
  const orgProductHref = useOrgProductPath();
  const Icon = item.icon;
  const base =
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors";

  if (item.soon || !item.href) {
    return (
      <div
        className={cn(base, "cursor-default text-muted-foreground/50")}
        aria-disabled
      >
        <Icon className="h-4 w-4" aria-hidden />
        <span className="flex-1">{item.label}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          Soon
        </span>
      </div>
    );
  }

  const href = item.productScoped ? orgProductHref(item.href) : orgHref(item.href);
  const active = pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        base,
        active
          ? "bg-secondary font-medium text-secondary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span>{item.label}</span>
    </Link>
  );
}
