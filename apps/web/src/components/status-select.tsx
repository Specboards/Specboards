"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import type { StatusWorkflow } from "@specboards/core";

import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { patchFeature } from "@/lib/api-client/work-items";
import { Select } from "@/components/ui/select";
import { statusLabel, statusOptions } from "@/lib/feature-helpers";

/**
 * Inline status mover: only legal transitions are offered. `workflow` carries
 * the workspace's custom statuses/transitions; defaults to the built-in
 * workflow when omitted.
 */
export function StatusSelect({
  specId,
  status,
  className,
  canEdit = true,
  workflow,
}: {
  specId: string;
  status: string;
  className?: string;
  canEdit?: boolean;
  workflow?: StatusWorkflow;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Select
      value={status}
      disabled={pending || !canEdit}
      className={className}
      onChange={(e) => {
        const next = e.target.value;
        startTransition(async () => {
          try {
            await patchFeature(specId, { status: next });
          } catch (err) {
            if (redirectOnAuthExpiry(err, router)) return;
            // Reverts the optimistic value by re-rendering from the server.
          }
          router.refresh();
        });
      }}
    >
      {statusOptions(status, workflow).map((s) => (
        <option key={s} value={s}>
          {statusLabel(s, workflow)}
        </option>
      ))}
    </Select>
  );
}
