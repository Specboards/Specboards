"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * App-wide light/dark theme provider. Toggles the `.dark` class on <html>
 * (see globals.css tokens) and persists the choice in localStorage. The user
 * changes it from the sidebar profile menu or Settings → Profile.
 */
export function ThemeProvider({
  children,
  nonce,
}: {
  children: ReactNode;
  /** CSP nonce so next-themes' pre-hydration inline script is allowed to run. */
  nonce?: string;
}) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemeProvider>
  );
}
