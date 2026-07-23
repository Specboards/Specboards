"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";

import { ItemDetailView } from "@/components/item-detail-view";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AuthRequiredError, getItemDetail } from "@/lib/api-client";
import type { ItemDetailData } from "@/lib/item-detail";
import { useIsMobile } from "@/lib/use-media-query";
import { useOrgProductPath } from "@/lib/use-org";

const WIDTH_KEY = "specboard:item-flyout:width";
const MIN_WIDTH = 380;
const DEFAULT_WIDTH = 560;

/** Clamp a flyout width to the sensible range for the current viewport. */
function clampWidth(px: number): number {
  const max =
    typeof window !== "undefined"
      ? Math.min(1100, Math.round(window.innerWidth * 0.95))
      : 1100;
  return Math.max(MIN_WIDTH, Math.min(max, px));
}

/**
 * In-context editor: opens a resizable drawer for `specId`, loads the same
 * detail bundle the full item page uses, and renders the shared
 * {@link ItemDetailView}. The flyout and the full page are therefore identical
 * in layout; only the chrome (drag-to-resize, "open fullscreen") differs.
 */
export function FeatureEditSheet({
  specId,
  onClose,
}: {
  /** The item to edit, or null when the drawer is closed. */
  specId: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<ItemDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // Below sm the drawer is full-screen and the stored width / drag-to-resize
  // handle do not apply. (The drawer only opens on interaction, by which point
  // this has resolved, so there is no first-paint flash.)
  const isMobile = useIsMobile();
  const orgHref = useOrgProductPath();

  // Restore the last-used width once on mount (client-only).
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(WIDTH_KEY));
      if (saved) setWidth(clampWidth(saved));
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    if (!specId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setData(null);
    setError(null);
    getItemDetail(specId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AuthRequiredError) {
          window.location.href = `/sign-in?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load item.");
      });
    return () => {
      cancelled = true;
    };
  }, [specId]);

  // Drag-to-resize from the drawer's left edge; width persists across opens.
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      setWidth(clampWidth(window.innerWidth - ev.clientX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setWidth((w) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // best-effort
        }
        return w;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const fullscreenHref =
    data != null
      ? orgHref(`/backlog/${data.feature.level}/${data.feature.specId}`)
      : null;

  return (
    <Sheet open={specId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        style={isMobile ? undefined : { width, maxWidth: "95vw" }}
        className={
          isMobile ? "w-full max-w-full gap-0 p-0" : "max-w-[95vw] gap-0 p-0"
        }
      >
        {/* Left-edge resize handle (pointer-only; off on the full-screen mobile
            layout, where there is nothing to resize against). */}
        {!isMobile ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            onPointerDown={onResizeStart}
            className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30"
          />
        ) : null}
        <SheetHeader className="flex-row items-center justify-between gap-2 border-b px-5 py-3">
          <SheetTitle className="sr-only">
            {data?.feature.title ?? "Item"}
          </SheetTitle>
          {fullscreenHref ? (
            <Link
              href={fullscreenHref}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              <Maximize2 className="size-3.5" />
              Open fullscreen
            </Link>
          ) : (
            <span />
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : data ? (
            <ItemDetailView data={data} variant="flyout" />
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
