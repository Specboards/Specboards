"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Select } from "@/components/ui/select";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { patchFeature } from "@/lib/api-client/work-items";

/**
 * Parent picker in the Relationships section: reparents the item under a
 * candidate one level up (or detaches it). Commits on change.
 */
export function FeatureParentSelect({
  specId,
  parentSpecId,
  parentLabel,
  candidates,
  canEdit,
}: {
  specId: string;
  parentSpecId: string | null;
  /** Label of the level above (e.g. "Epic"). */
  parentLabel: string;
  candidates: { specId: string; title: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  async function onChange(value: string) {
    setSaving(true);
    try {
      await patchFeature(specId, { parentSpecId: value || null });
      router.refresh();
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        Parent ({parentLabel.toLowerCase()})
      </span>
      <Select
        defaultValue={parentSpecId ?? ""}
        onChange={(e) => void onChange(e.target.value)}
        disabled={!canEdit || saving}
        className="h-8"
      >
        <option value="">None</option>
        {candidates.map((c) => (
          <option key={c.specId} value={c.specId}>
            {c.title}
          </option>
        ))}
      </Select>
    </label>
  );
}
