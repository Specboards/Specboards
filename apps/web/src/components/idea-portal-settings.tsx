"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { updateIdeaSettings } from "@/lib/api-client/ideas";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import type { IdeaSettings } from "@/lib/store/types";

/**
 * The publish switch and heading for the public Ideas portal.
 *
 * What the portal may SHOW lives in `IdeaPortalVisibility`, deliberately
 * separate: this is the one control an admin flips in a hurry (to take a portal
 * down, say), and burying it among five multi-select fields would make the
 * urgent case the fiddly one.
 *
 * `portalEnabled` is the outer gate for everything, in the database as well as
 * here: the portal role's policies are all predicated on it, so switching it
 * off is total rather than cosmetic.
 */
export function IdeaPortalSettings({
  initial,
  canEdit,
}: {
  initial: IdeaSettings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.portalEnabled);
  const [title, setTitle] = useState(initial.portalTitle ?? "");
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== initial.portalEnabled ||
    title.trim() !== (initial.portalTitle ?? "");

  function onSave() {
    setError(null);
    startSave(async () => {
      try {
        const next = await updateIdeaSettings({
          portalEnabled: enabled,
          portalTitle: title.trim() || null,
        });
        setEnabled(next.portalEnabled);
        setTitle(next.portalTitle ?? "");
        toast.success("Portal settings saved");
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={!canEdit || saving}
          className="mt-0.5 size-4"
        />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">
            Publish the public portal
          </span>
          <span className="block text-xs text-muted-foreground">
            When published, customers can browse ideas, vote, and submit
            requests without an account. Only the products and stages selected
            below are shown.
          </span>
        </span>
      </label>

      <FormField label="Portal heading" className="max-w-sm">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit || saving}
          placeholder="Defaults to your organization name"
          className="h-8"
        />
      </FormField>

      {canEdit ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={onSave}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save settings"}
          </Button>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
