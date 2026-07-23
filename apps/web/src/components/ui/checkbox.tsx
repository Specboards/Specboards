import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The checkbox visual: a square that fills with the primary color and shows a
 * check when selected. Presentational by design. The interactive semantics live
 * on the parent control, either a toggle button carrying `aria-pressed` (the
 * gate checklist) or a `<label>` wrapping a hidden input. Decorative here, so it
 * is `aria-hidden`; announce state on the parent, not on this box.
 */
function Checkbox({
  checked,
  className,
}: {
  checked: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input",
        className,
      )}
    >
      {checked ? <Check className="size-3" strokeWidth={3} /> : null}
    </span>
  );
}

export { Checkbox };
