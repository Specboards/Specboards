import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { listSidebarOrgs, listSidebarProducts } from "@/lib/workspace-access";

import "./globals.css";

// Public origin of this deployment, so file-convention metadata (the OG image)
// resolves to absolute URLs. BETTER_AUTH_URL is set wherever the app runs
// hosted; unset (local file mode) Next falls back to localhost.
const appOrigin = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();

export const metadata = {
  metadataBase: appOrigin ? new URL(appOrigin) : undefined,
  title: "Specboard",
  description: "Spec-based product management over git-native specs.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [orgs, products, nonce] = await Promise.all([
    listSidebarOrgs(),
    listSidebarProducts(),
    headers().then((h) => h.get("x-nonce") ?? undefined),
  ]);
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider nonce={nonce}>
          <div className="flex min-h-screen">
            <AppSidebar orgs={orgs} products={products} />
            <main className="min-w-0 flex-1">
              <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
            </main>
          </div>
          <Toaster position="bottom-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
