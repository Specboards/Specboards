"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  BrandMark,
  SidebarBody,
  useNavHidden,
  type SidebarData,
} from "@/components/app-sidebar";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * Mobile top app bar + navigation drawer. Shown below `lg` (where the desktop
 * rail is hidden); a hamburger opens a left-side drawer that reuses the exact
 * sidebar content. Radix Dialog under the Sheet gives us the focus trap, Escape
 * handling, and scroll lock for free.
 */
export function MobileNav({ orgs = [], products = [], groups = [] }: SidebarData) {
  const hidden = useNavHidden();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer whenever the route changes (navigating via a link, the
  // command palette, or a back/forward gesture).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (hidden) return null;

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-1 border-b bg-background px-2 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={open}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0">
          {/* Radix requires a title for the dialog; the nav is self-describing. */}
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody
            orgs={orgs}
            products={products}
            groups={groups}
            onNavigate={() => setOpen(false)}
            header={<BrandMark />}
          />
        </SheetContent>
      </Sheet>
      <BrandMark />
    </header>
  );
}
