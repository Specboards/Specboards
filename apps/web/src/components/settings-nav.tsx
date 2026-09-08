"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { SettingsSection } from "@/lib/settings-sections";
import { useOrgPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";

/**
 * Left sub-navigation for the Settings section.
 *
 * Which sections these are is resolved on the server by the layout and handed
 * down, because the answer depends on the viewer's role and their product
 * grants and this is a client component. See `lib/settings-sections.ts` for
 * the rule, and for why hiding a section is not the same as blocking it.
 */
export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const pathname = usePathname();
  const orgHref = useOrgPath();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto border-b pb-px sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
      {sections.map((item) => {
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
