"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthRequiredError,
  deleteWorkItem,
  patchFeature,
} from "@/lib/api-client";
import { useOrgProductPath } from "@/lib/use-org";

/**
 * Manage controls for a DB-native work item (initiative/epic): rename it
 * (its title lives in the DB, not a spec) and delete it. Deleting orphans any
 * children rather than cascading. Rendered only for DB-native items the user
 * can edit.
 */
export function WorkItemControls({
  specId,
  title,
  levelLabel,
}: {
  specId: string;
  title: string;
  levelLabel: string;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();

  const level = levelLabel.toLowerCase();
  const trimmed = value.trim();
  const dirty = trimmed !== title && trimmed !== "";

  function onRename() {
    if (!dirty) return;
    startSave(async () => {
      setError(null);
      try {
        await patchFeature(specId, { title: trimmed });
        toast.success("Renamed");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Rename failed.");
      }
    });
  }

  function onDelete() {
    if (!window.confirm(`Delete this ${level}? Any child items are kept (orphaned).`))
      return;
    startDelete(async () => {
      setError(null);
      try {
        await deleteWorkItem(specId);
        toast.success(`${levelLabel} deleted`);
        router.push(orgHref("/backlog"));
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-muted-foreground">
        Manage {level}
      </span>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8"
          aria-label="Title"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={onRename}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Rename"}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        size="sm"
        variant="destructive"
        onClick={onDelete}
        disabled={deleting}
      >
        {deleting ? "Deleting…" : `Delete ${level}`}
      </Button>
    </div>
  );
}
