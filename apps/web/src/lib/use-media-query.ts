"use client";

import { useSyncExternalStore } from "react";

/**
 * SSR-safe media query hook built on `useSyncExternalStore`, so the server and
 * first client render agree (both report `false`) and there is no hydration
 * mismatch. Use it for behavior (which sensors to attach, whether drag is
 * enabled), and prefer CSS breakpoints for layout so nothing flashes at the
 * wrong width on first paint.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True below Tailwind's `md` breakpoint (phones). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** True on touch / stylus devices, where drag needs a long-press to lift. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

/** True when the user has asked the OS to minimize non-essential motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
