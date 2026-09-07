import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";

/**
 * The app's own 404.
 *
 * Next ships a built-in one, and it renders an inline `<style>` carrying no
 * nonce, which our `style-src 'self' 'nonce-…'` policy refuses: every 404
 * arrived unstyled, with "Refused to apply a stylesheet" in the console. Ours is
 * built from the same primitives as the rest of the app, so its styling comes
 * from the bundled sheet and nothing inline needs a nonce.
 *
 * Rendered inside the root layout, so the reader keeps the navigation and can
 * leave without reaching for the back button.
 */
export default function NotFound() {
  return (
    <EmptyState
      title="We could not find that page"
      description="The link may be out of date, or the item may have been deleted."
      action={
        <Link href="/" className={buttonVariants({ variant: "secondary" })}>
          Back to your workspace
        </Link>
      }
    />
  );
}
