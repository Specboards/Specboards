import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Native `<select>` styled to match the shadcn input/select trigger. Used
 * instead of the Radix select so server-rendered forms work without client
 * JS - fits the minimal, base-shadcn styling goal.
 *
 * `appearance-none` is what makes it match the Input beside it, and it also
 * removes the platform's arrow, so `select-chevron` (in globals.css) draws one
 * back. Without it a select and a text field are the same rectangle, and the
 * only way to discover which is which is to click. The right padding is what
 * keeps a long option from running underneath the chevron.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, ...props }, ref) => (
  <select
    className={cn(
      "select-chevron flex h-8 w-full appearance-none items-center rounded-md border border-input bg-transparent py-1 pl-3 pr-8 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Select.displayName = "Select";

export { Select };
