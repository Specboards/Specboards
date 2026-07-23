import type { Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { ThemeProvider } from "@/components/theme-provider";
import { WebpackNonce } from "@/components/webpack-nonce";
import {
  listSidebarGroups,
  listSidebarOrgs,
  listSidebarProducts,
} from "@/lib/workspace-access";

import "./globals.css";
// sonner ships its CSS as a static file. We import it here (bundled, served
// from 'self') instead of letting sonner inject an un-nonced <style> at
// runtime, which our patch disables. That lets the CSP drop `'unsafe-inline'`
// from `style-src`. See patches/sonner@2.0.7.patch and middleware.ts.
import "sonner/dist/styles.css";

// Public origin of this deployment, so file-convention metadata (the OG image)
// resolves to absolute URLs. BETTER_AUTH_URL is set wherever the app runs
// hosted; unset (local file mode) Next falls back to localhost.
const appOrigin = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();

export const metadata = {
  metadataBase: appOrigin ? new URL(appOrigin) : undefined,
  title: "Specboards",
  description: "Spec-based product management over git-native specs.",
};

// Next 15 wants the viewport as its own export, not a metadata key. Without
// `width=device-width` mobile browsers render the page at a desktop width and
// scale it down, which is why the app has felt unusable on phones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [orgs, products, groups, nonce] = await Promise.all([
    listSidebarOrgs(),
    listSidebarProducts(),
    listSidebarGroups(),
    headers().then((h) => h.get("x-nonce") ?? undefined),
  ]);
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <WebpackNonce nonce={nonce} />
        {/* Skip link: first focusable element, visually hidden until focused
            so keyboard users can jump past the nav straight to page content. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <ThemeProvider nonce={nonce}>
          <div className="flex min-h-screen">
            <AppSidebar orgs={orgs} products={products} groups={groups} />
            <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</div>
            </main>
          </div>
          <CommandPalette />
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
