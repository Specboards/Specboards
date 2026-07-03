"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AuthRequiredError, deleteWorkItem } from "@/lib/api-client";
import { useOrgProductPath } from "@/lib/use-org";

/**
 * Delete control for a DB-native work item (initiative/epic/…). Deleting
 * orphans any children rather than cascading. Renaming is done inline on the
 * item's title (see {@link ItemTitle}), so this is delete-only.
 *
 * `redirectOnDelete` sends the user back to the backlog after deletion (used on
 * the full page); the flyout leaves navigation to its own close handling.
 */
export function WorkItemDelete({
  specId,
  levelLabel,
  redirectOnDelete = true,
}: {
  specId: string;
  levelLabel: string;
  redirectOnDelete?: boolean;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [deleting, startDelete] = useTransition();

  const level = levelLabel.toLowerCase();

  function onDelete() {
    if (
      !window.confirm(
        `Delete this ${level}? Any child items are kept (orphaned).`,
      )
    )
      return;
    startDelete(async () => {
      try {
        await deleteWorkItem(specId);
        toast.success(`${levelLabel} deleted`);
        if (redirectOnDelete) router.push(orgHref("/backlog"));
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <div className="pt-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={onDelete}
        disabled={deleting}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {deleting ? "Deleting…" : `Delete ${level}`}
      </Button>
    </div>
  );
}
