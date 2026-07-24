import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Native `<select>` styled to match the shadcn input/select trigger. Used
 * instead of the Radix select so server-rendered forms work without client
 * JS — fits the minimal, base-shadcn styling goal.
 */
const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, ...props }, ref) => (
  <select
    className={cn(
      "flex h-8 w-full appearance-none items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Select.displayName = "Select";

export { Select };
