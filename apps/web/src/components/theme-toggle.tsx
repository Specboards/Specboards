"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/**
 * Segmented light / dark / system control. Renders a stable placeholder until
 * mounted so server and client markup match (theme is only known client-side).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? (theme ?? "system") : undefined;

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border bg-background p-0.5",
        className,
      )}
      role="group"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-pressed={active === value}
          className={cn(
            "flex items-center justify-center gap-1 rounded px-1.5 py-1 text-xs font-medium transition-colors",
            active === value
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
