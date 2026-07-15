"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AuthRequiredError, saveBoardPreferences } from "@/lib/api-client";
import type { BoardKey } from "@/lib/store";

/**
 * Shared board display preferences (which fields show on cards, and the
 * "featured" custom field). Held in client state so the toolbar menu and the
 * board update **instantly** when toggled, with the change persisted in the
 * background — no page refresh needed. Seeded once from the server-resolved
 * values; the API de-dupes and the stored order follows `orderedKeys`.
 */
interface BoardPrefs {
  cardFields: string[];
  featured: string | null;
  toggleField: (key: string) => void;
  setFeatured: (key: string | null) => void;
}

const BoardPrefsContext = createContext<BoardPrefs | null>(null);

export function BoardPrefsProvider({
  board = "backlog",
  initialFields,
  initialFeatured,
  orderedKeys,
  children,
}: {
  /** Which space these prefs belong to; persisted independently per board. */
  board?: BoardKey;
  initialFields: string[];
  initialFeatured: string | null;
  /** Canonical field order used when persisting the selection. */
  orderedKeys: string[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [cardFields, setCardFields] = useState<string[]>(initialFields);
  const [featured, setFeaturedState] = useState<string | null>(initialFeatured);

  const persist = useCallback(
    (fields: string[], nextFeatured: string | null) => {
      // Store in canonical order; the API de-dupes.
      const ordered = orderedKeys.filter((k) => fields.includes(k));
      saveBoardPreferences(
        { cardFields: ordered, featured: nextFeatured },
        board,
      ).catch((err) => {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(
          err instanceof Error ? err.message : "Couldn't save preferences.",
        );
      });
    },
    [board, orderedKeys, router],
  );

  const toggleField = useCallback(
    (key: string) => {
      setCardFields((prev) => {
        const next = prev.includes(key)
          ? prev.filter((k) => k !== key)
          : [...prev, key];
        persist(next, featured);
        return next;
      });
    },
    [featured, persist],
  );

  const setFeatured = useCallback(
    (key: string | null) => {
      setFeaturedState(key);
      persist(cardFields, key);
    },
    [cardFields, persist],
  );

  return (
    <BoardPrefsContext.Provider
      value={{ cardFields, featured, toggleField, setFeatured }}
    >
      {children}
    </BoardPrefsContext.Provider>
  );
}

export function useBoardPrefs(): BoardPrefs {
  const ctx = useContext(BoardPrefsContext);
  if (!ctx) {
    throw new Error("useBoardPrefs must be used within a BoardPrefsProvider");
  }
  return ctx;
}
