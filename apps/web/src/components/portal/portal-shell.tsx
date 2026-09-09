import type { ReactNode } from "react";

/**
 * Chrome for every public portal page.
 *
 * A server component with no interactivity and no client bundle, which is the
 * point rather than an optimisation: the less this page does, the less there is
 * to accidentally do with the session cookie it receives.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 * No sidebar, no product switcher, no org switcher, no sign-in link and no
 * route back into the pre-release sign-up gate. A visitor here is a customer of
 * the workspace, not a prospect for us, and a portal that advertises its own
 * platform on somebody else's branded page is doing the wrong job. The one
 * exception is the footer attribution, which is small, factual, and the honest
 * price of a hosted portal.
 *
 * The heading comes from `idea_settings.portal_title`, falling back to the
 * workspace name (`resolvePortal`), so the page is titled the way the customer
 * chose rather than the way our schema stores them.
 */
export function PortalShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ideas and feedback
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">{children}</main>

      <footer className="mx-auto max-w-3xl px-6 pb-10">
        <p className="text-xs text-muted-foreground">Powered by Specboards</p>
      </footer>
    </div>
  );
}
