"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Info, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Tooltip built on Radix Tooltip (the shadcn pattern), plus {@link InfoTip} for
 * the common case: an icon that reveals a caveat about the thing beside it.
 *
 * Radix gives us the hover and keyboard-focus model, Escape to dismiss, and the
 * `aria-describedby` wiring, so the content is announced rather than merely
 * drawn. What it deliberately does not give us is touch, because a tooltip has
 * no hover on a touchscreen; {@link InfoTip} closes that gap by opening on tap
 * and dismissing on a pointer down outside, so the text is never unreachable.
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={12}
      className={cn(
        "z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md",
        "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/**
 * An icon that carries a caveat about the value next to it.
 *
 * `tone` is not decoration: "warning" says the reading is qualified in a way
 * that changes what the number means, and that has to be visible before anyone
 * hovers. `label` is the trigger's accessible name, so it names the subject
 * ("what this window covers"), not the gesture ("more info").
 */
function InfoTip({
  label,
  tone = "muted",
  children,
  className,
}: {
  label: string;
  tone?: "muted" | "warning";
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            // Radix closes on pointer down so a click does not leave the
            // tooltip stuck open under the cursor. On a touchscreen that is the
            // only interaction there is, so reopening here is what makes the
            // text reachable at all; the outside-dismiss below closes it again.
            onClick={() => setOpen(true)}
            className={cn(
              "inline-flex size-4 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              tone === "warning"
                ? "text-[var(--warning-fg)] hover:text-[var(--warning-fg)]/80"
                : "text-muted-foreground hover:text-foreground",
              className,
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent onPointerDownOutside={() => setOpen(false)}>
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { InfoTip };
