import { cn } from "@/lib/utils";

/**
 * The Specboards mark, as an icon.
 *
 * One component rather than four copies of the same `<img>` and the same path
 * string, which is how three of them ended up with different alt text for the
 * same picture.
 *
 * It stays an `<img>`. `@next/next/no-img-element` argues from LCP and
 * bandwidth, and neither applies to a 24-32px PNG that is already smaller than
 * the request `next/image` would add to optimize it. On the auth and consent
 * cards that request would sit on the critical path of the first page a
 * self-hoster ever loads, to save nothing. The exception is here, once, instead
 * of at each call site.
 *
 * `alt` is empty by default because the mark sits beside the wordmark or a
 * card title that already names the product, and a screen reader announcing
 * "Specboards" twice is worse than not announcing the decoration. Pass `alt`
 * where it is the only thing identifying what the reader is looking at.
 */
export function SpecboardsMark({
  className,
  alt = "",
}: {
  className?: string;
  /** Leave empty when adjacent text already names the product. */
  alt?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/specboards-mark.png"
      alt={alt}
      className={cn("h-6 w-6", className)}
    />
  );
}
