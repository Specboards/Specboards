"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

type Announce = (message: string, opts?: { assertive?: boolean }) => void;

const AnnouncerContext = createContext<Announce | null>(null);

/**
 * A single pair of visually-hidden ARIA live regions (polite + assertive) mounted
 * once near the app root, plus a `useAnnouncer()` hook to push text into them.
 *
 * Use it for outcomes that have no visible, focus-following counterpart the
 * screen reader would already read: a drag/menu card move, an async save result.
 * Field-level validation stays inline via FormField's own live error slot.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  const announce = useCallback<Announce>((message, opts) => {
    const set = opts?.assertive ? setAssertive : setPolite;
    // Clear first, then set on a later tick. A live region only announces on a
    // change in text content, so blanking it guarantees that re-announcing the
    // same string (e.g. "Moved to Ready" twice) still fires.
    set("");
    window.setTimeout(() => set(message), 60);
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

/** Returns `announce(message, { assertive? })`. Must be under AnnouncerProvider. */
export function useAnnouncer(): Announce {
  const ctx = useContext(AnnouncerContext);
  if (!ctx) {
    throw new Error("useAnnouncer must be used within an AnnouncerProvider");
  }
  return ctx;
}
