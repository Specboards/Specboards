import { statusDotClassFor } from "@/lib/feature-helpers";
import { cn } from "@/lib/utils";

export function StatusDot({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        statusDotClassFor(status),
        className,
      )}
    />
  );
}
