"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp that does not take the rest of the page down with it.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * `toLocaleString()` formats in the server's timezone and locale during SSR,
 * and in the viewer's when it runs again in the browser. Those two strings
 * differ for anyone not sitting in UTC with the server's locale, which is
 * nearly everyone. React treats a text mismatch as a corrupted tree: it throws
 * (minified error #418) and the surrounding client component never receives
 * its event handlers.
 *
 * The symptom is not a broken date. It is buttons that do nothing, with no
 * error anywhere on screen, on whichever card happened to render a timestamp.
 * That is how it was found: "Send a test call" silently stopped working on the
 * model connection card, but only after a call had been made, because until
 * then the field read "Never" and matched on both sides.
 *
 * ── How this avoids it ──────────────────────────────────────────────────────
 * The first render is derived from the ISO string itself, so the server and
 * the browser produce the same characters and hydration is clean. The viewer's
 * own timezone and locale are applied in an effect, which runs after React has
 * stopped comparing. The cost is one frame of UTC, which beats a dead page.
 */
export function LocalTime({
  iso,
  options,
  fallback = "Never",
}: {
  /** ISO 8601 instant, or null for something that has not happened. */
  iso: string | null;
  /** How to render it once the viewer's own settings can be applied. */
  options?: Intl.DateTimeFormatOptions;
  /** Shown when `iso` is null. Cards differ on "Never" versus "never". */
  fallback?: string;
}) {
  const [text, setText] = useState(() => beforeHydration(iso, options, fallback));

  useEffect(() => {
    if (!iso) {
      setText(fallback);
      return;
    }
    const at = new Date(iso);
    // A value the browser cannot parse keeps the placeholder rather than
    // becoming "Invalid Date" in the middle of a settings screen.
    if (Number.isNaN(at.getTime())) return;
    setText(
      at.toLocaleString(
        undefined,
        options ?? { dateStyle: "medium", timeStyle: "short" },
      ),
    );
    // `options` is a literal at every call site, so it is compared by identity
    // on purpose: re-running this effect costs nothing and the alternative is
    // asking every caller to memoize a constant.
  }, [iso, options, fallback]);

  return <>{text}</>;
}

/** Whether a format asks for a time at all, or only a date. */
function wantsTime(options?: Intl.DateTimeFormatOptions): boolean {
  if (!options) return true;
  return Boolean(
    options.hour ?? options.minute ?? options.second ?? options.timeStyle,
  );
}

/**
 * The text both sides must agree on. Sliced straight off the ISO string rather
 * than formatted, so no locale, timezone or ICU version can come between the
 * server's output and the browser's first render.
 */
function beforeHydration(
  iso: string | null,
  options: Intl.DateTimeFormatOptions | undefined,
  fallback: string,
): string {
  if (!iso) return fallback;
  const date = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return iso;
  return wantsTime(options) ? `${date} ${iso.slice(11, 16)} UTC` : date;
}
