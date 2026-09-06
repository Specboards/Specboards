import { cn } from "@/lib/utils";

/**
 * A person: their picture, or the first letter of their name.
 *
 * One implementation on purpose. There were three, and they had already drifted
 * apart: the sidebar fell back to `secondary`, comments to `muted`, and the new
 * profile portrait re-derived the circle at a fourth size. The fallback is the
 * half that matters, because it is what most people see (an avatar is optional
 * and until recently could only be set by hosting the file elsewhere).
 *
 * The fallback is an initial rather than a generic silhouette: an initial tells
 * six colleagues apart in a list and a grey outline does not. See the Avatar
 * card in Gesso for the size scale and the do/don't.
 */

/** 24 dense, 28 default, 64 the Settings > Profile portrait. */
type AvatarSize = "sm" | "md" | "lg";

const SIZES: Record<AvatarSize, string> = {
  sm: "size-6 text-2xs",
  md: "size-7 text-xs",
  lg: "size-16 text-lg",
};

export function Avatar({
  name,
  image,
  size = "md",
  className,
  ...rest
}: {
  /** Display name, for the initial. Null/empty falls back to "?". */
  name?: string | null;
  /** Picture URL: an upload of ours, an external host, or none. */
  image?: string | null;
  size?: AvatarSize;
  className?: string;
} & Pick<React.HTMLAttributes<HTMLElement>, "aria-hidden">) {
  const shared = cn("shrink-0 rounded-full", SIZES[size], className);

  if (image) {
    return (
      // Decorative: every call site puts the person's name in text beside it,
      // so announcing it again would just repeat the next line.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={image} alt="" className={cn(shared, "object-cover")} {...rest} />
    );
  }

  const initial = (name ?? "").trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        shared,
        "flex items-center justify-center bg-muted font-medium text-muted-foreground",
      )}
      {...rest}
    >
      {initial}
    </span>
  );
}
