"use client";

import { useEffect } from "react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

/**
 * The app's error boundary: what a reader sees when a page throws on the client.
 *
 * There was none, so a client-side exception fell through to Next's built-in
 * fallback. That fallback tells the reader nothing they can act on, and it
 * renders an inline `<style>` with no nonce, which our `style-src` refuses, so
 * it arrived unstyled with a CSP error in the console on top of whatever
 * actually broke.
 *
 * `reset` re-renders the segment without a full reload, which is the right first
 * move for a transient failure. The digest is shown because it is the only
 * handle a reader can quote back to us: the message itself is stripped in a
 * production build.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logs already have the server-side half. This is the client half,
    // and without it a render loop or a bad payload leaves no trace at all.
    console.error("[specboards] unhandled client error", error);
  }, [error]);

  return (
    <EmptyState
      title="Something went wrong on this page"
      description={
        error.digest
          ? `Try again, and if it keeps happening quote reference ${error.digest}.`
          : "Try again, and if it keeps happening let us know what you were doing."
      }
      action={
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
