"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useOrgPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/notifications", label: "Notifications" },
  // Deployment configuration, not workspace configuration: how this instance
  // talks to a relay. On a hosted deployment that belongs to whoever runs it,
  // the screen is read-only, and there is nothing a workspace owner can do
  // there, so the entry is not offered. See `showEmail`.
  { href: "/settings/email", label: "Email" },
  { href: "/settings/company", label: "Company & Team" },
  { href: "/settings/products", label: "Products" },
  { href: "/settings/work-cards", label: "Cards" },
  { href: "/settings/tags", label: "Tags" },
  { href: "/settings/ideas", label: "Ideas" },
  { href: "/settings/hierarchy", label: "Hierarchy" },
  { href: "/settings/assistant", label: "Assistant" },
  { href: "/settings/branding", label: "Branding" },
  { href: "/settings/integrations", label: "Integrations" },
];

/**
 * Left sub-navigation for the Settings section.
 *
 * `showEmail` is resolved on the server by the layout, because tenancy is an
 * environment fact and this is a client component. A hosted tenant is not
 * shown a screen whose only content is somebody else's mail transport.
 */
export function SettingsNav({ showEmail }: { showEmail: boolean }) {
  const pathname = usePathname();
  const orgHref = useOrgPath();
  const items = showEmail
    ? ITEMS
    : ITEMS.filter((i) => i.href !== "/settings/email");
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto border-b pb-px sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
      {items.map((item) => {
        const href = orgHref(item.href);
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={item.href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-secondary font-medium text-secondary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
