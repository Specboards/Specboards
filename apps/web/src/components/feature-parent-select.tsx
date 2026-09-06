"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { patchFeature } from "@/lib/api-client/work-items";
import { useOrgProductPath } from "@/lib/use-org";

/**
 * The Parent sub-section of Relationships: states the item's parent, and
 * reparents it under a candidate one level up (or detaches it) on opt-in.
 *
 * An established parent is *content*, not a control. This used to render the
 * picker unconditionally and then repeat the parent underneath it as a link,
 * so the fact that the item had a parent was the second thing on the row, in
 * smaller type, below the control for changing it. A section whose only
 * plain sentences were "No work items yet." and "No relations yet." read as
 * empty while the parent was on screen twice.
 *
 * So: the parent renders once, as a row in the same shape as the children
 * beneath it, and the picker appears only when asked for (the "add" UX rule
 * in CLAUDE.md, and the same shape as Relations and GitHub alongside).
 *
 * There is no status dot on the row because `FeatureDetail` carries the
 * parent's title but not its status; adding one is a store change, not a
 * layout change. The level badge does the work of marking it as a record.
 */
export function FeatureParentSelect({
  specId,
  parentSpecId,
  parentTitle,
  parentLevelKey,
  parentLabel,
  candidates,
  canEdit,
}: {
  specId: string;
  parentSpecId: string | null;
  /** Title of the current parent, when there is one. */
  parentTitle: string | null;
  /** Level key of the level above, for the parent's own detail route. */
  parentLevelKey: string;
  /** Label of the level above (e.g. "Epic"). */
  parentLabel: string;
  candidates: { specId: string; title: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [saving, setSaving] = useState(false);
  const [changing, setChanging] = useState(false);
  const level = parentLabel.toLowerCase();

  async function onChange(value: string) {
    setSaving(true);
    try {
      await patchFeature(specId, { parentSpecId: value || null });
      setChanging(false);
      router.refresh();
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Parent ({level})
        </span>
        {canEdit && !changing ? (
          <Button
            size="inline"
            variant="link"
            onClick={() => setChanging(true)}
          >
            {parentSpecId ? "Change" : `Set ${level}`}
          </Button>
        ) : null}
      </div>

      {parentSpecId ? (
        <div className="flex items-center gap-2 text-sm">
          <Badge
            variant="outline"
            size="sm"
            className="shrink-0 uppercase tracking-wide"
          >
            {parentLabel}
          </Badge>
          <Link
            href={orgHref(`/backlog/${parentLevelKey}/${parentSpecId}`)}
            className="min-w-0 flex-1 truncate text-link hover:underline"
            title={parentTitle ?? parentSpecId}
          >
            {parentTitle ?? parentSpecId}
          </Link>
        </div>
      ) : !changing ? (
        <p className="text-xs text-muted-foreground">No {level} yet.</p>
      ) : null}

      {changing ? (
        <div className="space-y-2">
          <Select
            aria-label={`Parent ${level}`}
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setChanging(false)}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
