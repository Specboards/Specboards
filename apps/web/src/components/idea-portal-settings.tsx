"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { AuthRequiredError, updateIdeaSettings } from "@/lib/api-client";
import type { IdeaSettings } from "@/lib/store/types";

/**
 * Admin form for the public Ideas portal. The portal itself (a public,
 * unauthenticated voting page built on this data) is a later phase; this
 * captures its config now so it can ship as a flip of `portalEnabled`.
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
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
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
            When published, customers can browse open ideas, vote, and submit
            requests without an account. (Public site coming in a later release.)
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
