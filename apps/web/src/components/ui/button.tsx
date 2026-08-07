import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Flat, GitHub-native: 1px borders carry structure, no shadows. Green primary,
  // bordered neutral/outline/secondary, blue link.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-primary bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "border border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "border border-input bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        // `default` is the shared control height: h-8, the same as Input and
        // Select. Any control that sits in a toolbar row next to an input or a
        // select must use it, or the row comes out ragged. Do not reach for
        // `sm` to make a toolbar button "fit" and do not patch a height on with
        // `className="h-8"` — both are how this drifted before.
        default: "h-8 px-3 py-1",
        // Dense contexts only, where nothing lines up against a form control:
        // inside a card, a table row, or an inline empty-state action.
        sm: "h-7 rounded-md px-2.5 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-8 w-8",
        // No box: sits inline in a text run or a tight toolbar. Pair with
        // variant="link" (or "ghost") for an inline action that still gets the
        // shared focus ring, hover, and disabled treatment.
        inline: "h-auto p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
