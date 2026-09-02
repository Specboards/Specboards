"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { deleteWorkItem } from "@/lib/api-client/work-items";
import { useOrgProductPath } from "@/lib/use-org";

/**
 * Delete control for a work item. Deleting orphans any children rather than
 * cascading. Renaming is done inline on the item's title (see
 * {@link ItemTitle}), so this is delete-only.
 *
 * When the item has a spec attached, deleting it also deletes that spec file
 * from git, because a file left behind is re-imported by the next sync and the
 * item comes back (ADR 0003 D4). The confirmation says so, and names the file.
 *
 * `redirectOnDelete` sends the user back to the backlog after deletion (used on
 * the full page); the flyout leaves navigation to its own close handling.
 */
export function WorkItemDelete({
  specId,
  levelLabel,
  specPath = null,
  redirectOnDelete = true,
}: {
  specId: string;
  levelLabel: string;
  /** Path of the attached spec file, or null when the item has no spec. */
  specPath?: string | null;
  redirectOnDelete?: boolean;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [deleting, startDelete] = useTransition();

  const level = levelLabel.toLowerCase();

  function onDelete() {
    const message = specPath
      ? `Delete this ${level}? This also deletes ${specPath} from the connected repository, which cannot be undone here. Any child items are kept (orphaned).`
      : `Delete this ${level}? Any child items are kept (orphaned).`;
    if (!window.confirm(message)) return;
    startDelete(async () => {
      try {
        await deleteWorkItem(specId, { removeSpec: specPath !== null });
        toast.success(`${levelLabel} deleted`);
        if (redirectOnDelete) router.push(orgHref("/backlog"));
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
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
