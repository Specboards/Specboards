import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        // Primer "counter": a monospace number in a soft neutral round-pill,
        // like the count next to Issues / PRs.
        counter:
          "rounded-full border-transparent bg-muted font-mono text-muted-foreground",
      },
      size: {
        // sm keeps the chip padding and drops only the label to the 2xs step,
        // matching the dense metadata badges (card products, field chips) that
        // previously carried an ad-hoc text-[10px] override.
        default: "px-2 py-0.5 text-xs",
        sm: "px-2 py-0.5 text-2xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props} />
  );
}

export { Badge };
