"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  bulkPatchFeatures,
  type BulkTagOps,
} from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import type { FeaturePatch } from "@/lib/store/types";

/** Option lists the bulk bar needs to render its controls. */
export interface BulkOptions {
  statuses: string[];
  assignees: { userId: string; name: string }[];
  releases: { id: string; name: string }[];
}

/**
 * Floating action bar shown while one or more items are selected. Each control
 * applies a single field to the whole selection through the bulk API, reports
 * how many changed (and how many the server rejected, e.g. an illegal status
 * transition), then clears the selection. Selection lives in the parent view.
 */
export function BulkActionBar({
  selectedIds,
  options,
  onClear,
  onExit,
}: {
  selectedIds: string[];
  options: BulkOptions;
  /** Clear the selection but stay in multi-select mode (used after an apply). */
  onClear: () => void;
  /** Leave multi-select entirely (the Cancel button). */
  onExit: () => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const count = selectedIds.length;
  if (count === 0) return null;

  async function apply(
    patch: Pick<FeaturePatch, "status" | "assigneeId" | "releaseId">,
    tagOps: BulkTagOps,
    label: string,
  ) {
    setPending(true);
    try {
      const { okCount, failCount } = await bulkPatchFeatures(
        selectedIds,
        patch,
        tagOps,
      );
      if (okCount > 0) {
        toast.success(
          failCount > 0
            ? `${label} on ${okCount} item${okCount === 1 ? "" : "s"}; ${failCount} skipped`
            : `${label} on ${okCount} item${okCount === 1 ? "" : "s"}`,
        );
      } else {
        toast.error(`Couldn't ${label.toLowerCase()}: all ${failCount} items rejected`);
      }
      router.refresh();
      onClear();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Bulk edit failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2.5 rounded-lg border bg-background/95 px-4 py-2.5 shadow-lg backdrop-blur"
      role="toolbar"
      aria-label="Bulk actions"
      data-pending={pending}
    >
      <span className="whitespace-nowrap text-sm font-medium">
        {count} selected
      </span>
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <Select
        aria-label="Set status for selected"
        className="h-8 w-auto"
        value=""
        disabled={pending}
        onChange={(e) => {
          if (e.target.value) void apply({ status: e.target.value }, {}, "Set status");
        }}
      >
        <option value="">Set status…</option>
        {options.statuses.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </Select>

      <Select
        aria-label="Set assignee for selected"
        className="h-8 w-auto"
        value=""
        disabled={pending}
        onChange={(e) => {
          if (!e.target.value) return;
          const assigneeId = e.target.value === "unassigned" ? null : e.target.value;
          void apply({ assigneeId }, {}, "Set assignee");
        }}
      >
        <option value="">Set assignee…</option>
        <option value="unassigned">Unassigned</option>
        {options.assignees.map((a) => (
          <option key={a.userId} value={a.userId}>
            {a.name}
          </option>
        ))}
      </Select>

      {options.releases.length > 0 ? (
        <Select
          aria-label="Set release for selected"
          className="h-8 w-auto"
          value=""
          disabled={pending}
          onChange={(e) => {
            if (!e.target.value) return;
            const releaseId = e.target.value === "none" ? null : e.target.value;
            void apply({ releaseId }, {}, "Set release");
          }}
        >
          <option value="">Set release…</option>
          <option value="none">No release</option>
          {options.releases.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      ) : null}

      <Input
        aria-label="Add a tag to selected"
        placeholder="Add tag…"
        className="h-8 w-28"
        value={tagInput}
        disabled={pending}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const tag = tagInput.trim();
          if (!tag) return;
          setTagInput("");
          void apply({}, { addTags: [tag] }, `Add tag "${tag}"`);
        }}
      />
      <button
        type="button"
        onClick={() => void apply({}, { clearTags: true }, "Clear tags")}
        disabled={pending}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
      >
        Clear tags
      </button>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
      <Button
        size="sm"
        variant="ghost"
        onClick={onExit}
        disabled={pending}
      >
        Cancel
      </Button>
    </div>
  );
}
