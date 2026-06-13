"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const items = [
  { href: "/backlog", label: "Backlog" },
  { href: "/board", label: "Board" },
  { href: "/roadmap", label: "Roadmap" },
];

export function MainNav() {
  const pathname = usePathname();
  const { data, isPending, error } = useSession();

  // Hide the app nav from signed-out visitors (the only pages they reach are
  // /sign-in, /sign-up, /setup). Mirrors AccountControl: while the session is
  // still loading show nothing to avoid a flash; an `error` means the session
  // endpoint is disabled (local/self-host file mode), where pages are ungated
  // and the nav should always show.
  if (isPending) return null;
  if (!data?.user && !error) return null;

  return (
    <nav className="flex items-center gap-5 text-sm">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "transition-colors hover:text-foreground",
            pathname.startsWith(item.href)
              ? "text-foreground"
              : "text-muted-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
