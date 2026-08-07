"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ListChecks } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/lib/use-media-query";

interface BoardSelection {
  /** Whether bulk actions are available at all (drives the toggle's presence). */
  canSelect: boolean;
  selectMode: boolean;
  enter: () => void;
  exit: () => void;
}

const BoardSelectionContext = createContext<BoardSelection | null>(null);

/**
 * Multi-select mode for a board or table, held above both the toolbar and the
 * board itself.
 *
 * The mode used to live inside each board component, which meant the toggle had
 * to render there too: a right-aligned row of its own, stacked under the
 * filters and out of line with every other view control. Lifting just the
 * boolean lets the toggle sit in the toolbar with the rest of the controls,
 * while the set of selected ids stays with the board that owns the cards.
 *
 * Escape leaves multi-select from anywhere, which is why the key handler lives
 * here rather than in the consumer.
 */
export function BoardSelectionProvider({
  canSelect,
  disableOnMobile = false,
  children,
}: {
  canSelect: boolean;
  /**
   * Drop selection below the md breakpoint. The roadmap board becomes a swipe
   * carousel there and cannot be selected into, so its toggle would be a button
   * that does nothing. Resolved here rather than by the caller because the
   * breakpoint is only known on the client.
   */
  disableOnMobile?: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const available = canSelect && !(disableOnMobile && isMobile);
  const [selectMode, setSelectMode] = useState(false);
  const enter = useCallback(() => setSelectMode(true), []);
  const exit = useCallback(() => setSelectMode(false), []);

  useEffect(() => {
    if (!available) setSelectMode(false);
  }, [available]);

  useEffect(() => {
    if (!selectMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exit]);

  return (
    <BoardSelectionContext.Provider
      value={{
        canSelect: available,
        selectMode: selectMode && available,
        enter,
        exit,
      }}
    >
      {children}
    </BoardSelectionContext.Provider>
  );
}

/**
 * Read multi-select state. Returns an inert value outside a provider so a board
 * rendered on its own (or in a test) simply has the feature switched off rather
 * than throwing.
 */
export function useBoardSelection(): BoardSelection {
  return (
    useContext(BoardSelectionContext) ?? {
      canSelect: false,
      selectMode: false,
      enter: () => {},
      exit: () => {},
    }
  );
}

/**
 * The toolbar's multi-select toggle. Renders nothing when the surface has no
 * bulk actions, so it can sit unconditionally in a toolbar's control cluster.
 */
export function BoardSelectToggle() {
  const { canSelect, selectMode, enter, exit } = useBoardSelection();
  if (!canSelect) return null;
  return (
    <Button
      type="button"
      variant={selectMode ? "secondary" : "outline"}
      onClick={() => (selectMode ? exit() : enter())}
      className="gap-1.5"
    >
      <ListChecks className="h-4 w-4" />
      {selectMode ? "Done" : "Select"}
    </Button>
  );
}
