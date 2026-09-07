"use client";

import "./globals.css";

/**
 * The last resort: an error thrown by the root layout itself, where `error.tsx`
 * cannot help because the layout it renders inside is the thing that failed.
 * Next replaces the whole document with this, so it owns `<html>` and `<body>`.
 *
 * Deliberately plain, and deliberately not inline-styled. Next's built-in
 * version of this page styles itself with an inline `<style>` that carries no
 * nonce, which our `style-src 'self' 'nonce-…'` policy refuses; the classes here
 * come from the bundled sheet, which is served from 'self' and needs no nonce.
 * Nothing here may depend on providers or app state: at this point none of them
 * are running.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">
            Specboards could not load
          </h1>
          <p className="text-sm text-muted-foreground">
            {error.digest
              ? `Reload to try again. If it keeps happening, quote reference ${error.digest}.`
              : "Reload to try again. If it keeps happening, let us know what you were doing."}
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
