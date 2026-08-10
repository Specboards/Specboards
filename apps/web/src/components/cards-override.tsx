"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AuthRequiredError } from "@/lib/api-client";

/**
 * The inherited-versus-overridden frame every per-product Cards setting sits
 * in.
 *
 * Two rules from the UX conventions drive the shape. An override starts as an
 * affordance, not an open form: a product following the workspace default shows
 * that default read-only with an "Override for this product" control, rather
 * than a pre-filled editor implying it already has its own configuration.
 * And going back has to be as easy as going forward, so an overridden setting
 * always offers a revert.
 *
 * Both directions are destructive enough to confirm in words rather than
 * silently: overriding copies the default into the product so the admin starts
 * from what they already had, and reverting drops the product's own rows.
 */
export function CardsOverride({
  /** Null when configuring the workspace default, where inheritance is n/a. */
  productId: _productId,
  overridden,
  canEdit,
  label,
  onOverride,
  onRevert,
  children,
}: {
  productId: string | null;
  /** Whether this product has its own configuration for this setting. */
  overridden: boolean;
  canEdit: boolean;
  /** What is being overridden, for the copy: "stages", "properties". */
  label: string;
  /** Seed this product's own configuration from what it currently inherits. */
  onOverride: () => Promise<void>;
  /** Drop this product's own configuration and follow the workspace again. */
  onRevert: () => Promise<void>;
  /** The editor, rendered only once the product owns its configuration. */
  children: ReactNode;
}) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<void>, done: string) {
    setError(null);
    startSave(async () => {
      try {
        await action();
        toast.success(done);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {overridden
            ? `This product has its own ${label}.`
            : `Following the workspace default ${label}.`}
        </p>
        {canEdit ? (
          overridden ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() =>
                run(
                  onRevert,
                  `Now following the workspace default ${label}.`,
                )
              }
            >
              Revert to workspace default
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() =>
                run(
                  onOverride,
                  `This product now has its own ${label}.`,
                )
              }
            >
              Override for this product
            </Button>
          )
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {/* Rendered either way: an inherited setting is still worth reading, it
          just is not editable here. The editors take `canEdit` themselves. */}
      {children}
    </div>
  );
}
