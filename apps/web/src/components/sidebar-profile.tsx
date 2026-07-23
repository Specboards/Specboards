"use client";

import { ChevronsUpDown, LogOut, Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { signOut, useSession } from "@/lib/auth-client";
import { useOrgPath } from "@/lib/use-org";
import { cn } from "@/lib/utils";

/**
 * Account control pinned to the bottom of the sidebar: avatar + name, opening a
 * menu with the theme toggle, a Settings link, and sign-out. In local file mode
 * (auth disabled — the session endpoint errors) there's no account, so it
 * degrades to a bare theme toggle so dark mode still works.
 */
export function SidebarProfile({ collapsed = false }: { collapsed?: boolean }) {
  const { data, isPending, error } = useSession();
  const router = useRouter();
  const orgHref = useOrgPath();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (isPending) return null;

  if (!data?.user) {
    // Local file mode (error) or signed-out: just expose the theme control.
    return <ThemeToggle className="w-full justify-center" />;
  }

  const { name, email, image } = data.user;

  function onSignOut() {
    startTransition(async () => {
      await signOut();
      router.push("/sign-in");
      router.refresh();
    });
  }

  return (
    <div ref={ref} className="relative">
      {open ? (
        <div
          className={cn(
            "absolute bottom-full left-0 mb-2 space-y-1 rounded-md border bg-popover p-2 shadow-md",
            collapsed ? "w-48" : "w-full",
          )}
        >
          <div className="pb-1">
            <ThemeToggle className="w-full justify-center" />
          </div>
          <Link
            href={orgHref("/settings")}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden />
            Settings
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            disabled={pending}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? name : undefined}
        aria-label={collapsed ? name : undefined}
        className={cn(
          "flex w-full items-center rounded-md py-2 transition-colors hover:bg-muted",
          collapsed ? "justify-center px-0" : "gap-2.5 px-2 text-left",
          open && "bg-muted",
        )}
      >
        <Avatar name={name} image={image} />
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {email}
              </span>
            </span>
            <ChevronsUpDown
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          </>
        ) : null}
      </button>
    </div>
  );
}

function Avatar({ name, image }: { name: string; image?: string | null }) {
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        className="h-7 w-7 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
      {initial}
    </span>
  );
}
