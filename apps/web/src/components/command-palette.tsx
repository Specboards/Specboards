"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { buildNavGroups, HIDDEN_PREFIXES } from "@/lib/nav-model";
import {
  useOrgPath,
  useOrgProductPath,
  useOrgSlug,
  useProductSlug,
} from "@/lib/use-org";
import { cn } from "@/lib/utils";

interface Command {
  label: string;
  /** The group the destination lives under, shown as a hint. */
  group?: string;
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
}

/**
 * Cmd-K command palette. Opens from anywhere with Cmd/Ctrl-K (Esc / click-away
 * closes) and jumps to the app's navigation destinations, resolved against the
 * active org and product. Built on Radix Dialog (no `cmdk` dependency) to stay
 * consistent with the tightened CSP - Radix's scroll-lock style is nonced by our
 * patch, and this component injects no styles of its own.
 *
 * v1 covers navigation only; item search and quick actions are follow-on slices.
 * Commands come from the same nav model the sidebar renders, so the two stay in
 * sync.
 */
export function CommandPalette() {
  const pathname = usePathname();
  const router = useRouter();
  const orgSlug = useOrgSlug();
  const productSlug = useProductSlug();
  const orgHref = useOrgPath();
  const orgProductHref = useOrgProductPath();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const hidden = HIDDEN_PREFIXES.some((p) => pathname.startsWith(p)) || !orgSlug;

  // Cmd/Ctrl-K toggles the palette from anywhere.
  useEffect(() => {
    if (hidden) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);

  // Flatten the shared nav model into navigable commands (skip "soon" items and
  // anything without a route), resolving product-scoped hrefs to the active
  // product.
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    for (const group of buildNavGroups(productSlug)) {
      for (const item of group.items) {
        if (item.soon || !item.href) continue;
        out.push({
          label: item.label,
          group: group.label,
          href: item.productScoped ? orgProductHref(item.href) : orgHref(item.href),
          Icon: item.icon,
        });
      }
    }
    return out;
  }, [productSlug, orgHref, orgProductHref]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.group?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  // Keep the highlight in range as the result set shrinks/grows.
  useEffect(() => {
    setHighlight((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results.length]);

  // Reset transient state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (results.length ? (h + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (results.length ? (h - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[highlight];
      if (target) go(target.href);
    }
  }

  if (hidden) return null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-16 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border bg-popover shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:top-24"
          aria-label="Command palette"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Jump to…"
            aria-label="Search commands"
            className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <ul className="max-h-80 overflow-y-auto p-1">
            {results.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matches
              </li>
            ) : (
              results.map((c, i) => {
                const Icon = c.Icon;
                return (
                  <li key={c.href}>
                    <button
                      type="button"
                      onClick={() => go(c.href)}
                      onMouseMove={() => setHighlight(i)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm",
                        i === highlight
                          ? "bg-secondary text-secondary-foreground"
                          : "text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span className="flex-1">{c.label}</span>
                      {c.group ? (
                        <span className="text-xs text-muted-foreground">{c.group}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
