"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import type { PortalProduct } from "@/lib/portal/ideas";

/**
 * "Suggest an idea": the one interactive thing on the public portal.
 *
 * ── Why this is allowed to be a client component ───────────────────────────
 * Everything else under `app/[org]/ideas` is a server component with no client
 * bundle, and that is a rule with a reason rather than a preference: the less
 * the portal does, the less there is to accidentally do with the session cookie
 * it receives from a signed-in visitor. This ships JavaScript because a form
 * that reports its own errors and collapses on success cannot be done with a
 * plain POST-and-redirect without losing what the visitor typed.
 *
 * What keeps that safe is that a client component cannot read the session even
 * by accident: it has no server context to read it from, and the endpoint it
 * posts to reads none either. `portal-auth-isolation.test.ts` still scans this
 * file for the forbidden names.
 *
 * ── The affordance, not an open form ───────────────────────────────────────
 * CLAUDE.md's rule, and it earns its keep here more than anywhere in the app:
 * this page's job is reading other people's ideas, and a permanently open form
 * would say the opposite on every visit. It expands in place, offers Cancel,
 * and collapses back after a successful save.
 */
export function IdeaSubmit({
  orgSlug,
  products,
}: {
  orgSlug: string;
  /** Products this portal publishes. A picker appears only when there are 2+. */
  products: PortalProduct[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sending, startSend] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { moderated: boolean }>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  /**
   * Move focus into the form when it opens.
   *
   * Deliberately a ref rather than `autoFocus`, which `jsx-a11y/no-autofocus`
   * flags and is right to: an autofocused field steals focus on page load,
   * which on a page whose actual job is reading other people's ideas would drag
   * a screen reader or a keyboard user straight past all of them.
   *
   * This is the opposite situation, and the distinction is the trigger. The
   * visitor has just pressed "Suggest an idea"; the form replaced the button
   * they were focused on, so leaving focus where it was would strand it on a
   * node that no longer exists. Firing only on the open transition means it
   * never happens on load, on hydration, or on a re-render.
   */
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setError(null);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError(null);

    startSend(async () => {
      try {
        const res = await fetch(
          `/api/portal/${encodeURIComponent(orgSlug)}/ideas`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: data.get("title"),
              description: data.get("description"),
              name: data.get("name"),
              email: data.get("email"),
              productId: data.get("productId") ?? products[0]?.id,
              // The honeypot. Hidden from people, filled in by bots, and the
              // endpoint answers 200 to both so a bot learns nothing.
              website: data.get("website"),
            }),
          },
        );
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          moderated?: boolean;
          error?: string;
        } | null;
        if (!res.ok || !body?.ok) {
          setError(body?.error ?? "We could not submit your idea.");
          return;
        }
        form.reset();
        setOpen(false);
        setDone({ moderated: body.moderated !== false });
        // An immediately-published idea should appear in the list behind the
        // form. A moderated one will not, which is why the confirmation says
        // so rather than leaving the visitor looking for it.
        router.refresh();
      } catch {
        setError("We could not reach the server. Please try again.");
      }
    });
  }

  if (done) {
    return (
      <div className="rounded-lg border border-dashed p-4">
        <p className="text-sm font-medium">Thanks, we have your idea.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {done.moderated
            ? "The team will review it, and it will appear here once they publish it. We have emailed you a copy."
            : "It is on this page now. We have emailed you a copy."}
        </p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="mt-3 text-sm text-link hover:underline"
        >
          Suggest another
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
      >
        Suggest an idea
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-lg border p-4"
      // The portal has no design-system client components (they would pull the
      // app's bundle onto a public page), so these are plain elements styled
      // with the same tokens the rest of the portal uses.
    >
      <Labelled label="Your idea" htmlFor="portal-idea-title">
        <input
          id="portal-idea-title"
          name="title"
          ref={titleRef}
          required
          maxLength={200}
          placeholder="A short summary"
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Details" htmlFor="portal-idea-description" optional>
        <textarea
          id="portal-idea-description"
          name="description"
          rows={4}
          maxLength={4000}
          placeholder="What would you like to be able to do, and why?"
          className={inputClass}
        />
      </Labelled>

      {products.length > 1 ? (
        <Labelled label="Which product" htmlFor="portal-idea-product">
          <select
            id="portal-idea-product"
            name="productId"
            required
            defaultValue=""
            className={inputClass}
          >
            <option value="" disabled>
              Choose one
            </option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Labelled>
      ) : (
        // One published product needs no question. The endpoint defaults to the
        // portal's only product, so nothing is sent and nothing is guessed.
        null
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Your name" htmlFor="portal-idea-name" optional>
          <input
            id="portal-idea-name"
            name="name"
            maxLength={200}
            className={inputClass}
          />
        </Labelled>
        <Labelled label="Your email" htmlFor="portal-idea-email">
          <input
            id="portal-idea-email"
            name="email"
            type="email"
            required
            maxLength={320}
            className={inputClass}
          />
        </Labelled>
      </div>
      <p className="text-xs text-muted-foreground">
        We use your email to confirm your idea and tell you what happens to it.
        It is never shown publicly.
      </p>

      {/* Honeypot. Hidden from people (including screen readers, via
          aria-hidden and tabIndex) and irresistible to bots. Not
          `display: none`, which some bots skip; off-screen, which they do
          not. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-[-9999px] h-0 w-0 overflow-hidden"
      >
        <label htmlFor="portal-idea-website">Leave this empty</label>
        <input
          id="portal-idea-website"
          name="website"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={sending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {sending ? "Sending…" : "Submit idea"}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={sending}
          className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Labelled({
  label,
  htmlFor,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium">
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-muted-foreground">
            (optional)
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}
