import { cn } from "@/lib/cn";

/** SpecBoard wordmark with a small board-glyph mark. Self-contained SVG — no
 * asset files needed. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <Mark className="h-6 w-6" />
      <span className="text-[1.05rem] text-gray-900">SpecBoard</span>
    </span>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--color-brand)" />
      {/* three stacked "board" columns */}
      <rect x="6" y="6" width="3" height="12" rx="1.5" fill="white" opacity="0.95" />
      <rect x="10.5" y="6" width="3" height="8" rx="1.5" fill="white" opacity="0.8" />
      <rect x="15" y="6" width="3" height="5" rx="1.5" fill="white" opacity="0.65" />
    </svg>
  );
}
