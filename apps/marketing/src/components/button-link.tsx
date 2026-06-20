import type { AnchorHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-white shadow-sm hover:bg-brand-dark",
  secondary: "border border-gray-200 bg-white text-gray-900 shadow-sm hover:bg-gray-50",
  ghost: "text-gray-600 hover:text-gray-900",
};

const sizes: Record<Size, string> = {
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  size?: Size;
};

/** Styled anchor used for every call-to-action on the marketing site. */
export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: Props) {
  return <a className={cn(base, variants[variant], sizes[size], className)} {...props} />;
}
