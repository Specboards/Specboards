"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  AuthRequiredError,
  addRelation,
  removeRelation,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useOrgProductPath } from "@/lib/use-org";
import {
  RELATION_DIRECTIONS,
  type CreatableRelationDirection,
  type FeatureRelation,
  type RelationDirection,
} from "@/lib/store/types";

/** Human labels for each relation direction (viewer's perspective). */
const DIRECTION_LABEL: Record<RelationDirection, string> = {
  blocked_by: "Blocked by",
  blocks: "Blocks",
  relates_to: "Relates to",
  duplicates: "Duplicates",
  duplicated_by: "Duplicated by",
};

/** Order relations are grouped/rendered in. */
const DISPLAY_ORDER: RelationDirection[] = [
  "blocked_by",
  "blocks",
  "relates_to",
  "duplicates",
  "duplicated_by",
];

type Candidate = { specId: string; title: string };

/** Relations editor for the feature detail sidebar (deps & relations). */
export function FeatureRelations({
  specId,
  relations,
  candidates,
  canEdit = true,
}: {
  specId: string;
  relations: FeatureRelation[];
  candidates: Candidate[];
  canEdit?: boolean;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function handleAuth(err: unknown): boolean {
    if (err instanceof AuthRequiredError) {
      router.push(
        `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
      );
      return true;
    }
    return false;
  }

  function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const toSpecId = String(data.get("toSpecId") ?? "");
    const direction = String(
      data.get("direction") ?? "",
    ) as CreatableRelationDirection;
    if (!toSpecId) {
      setError("Pick a feature to relate.");
      return;
    }
    startTransition(async () => {
      setError(null);
      try {
        await addRelation(specId, { toSpecId, direction });
        form.reset();
        setAdding(false);
        router.refresh();
      } catch (err) {
        if (handleAuth(err)) return;
        setError(
          err instanceof Error ? err.message : "Could not add relation.",
        );
      }
    });
  }

  function onRemove(linkId: string) {
    startTransition(async () => {
      setError(null);
      try {
        await removeRelation(specId, linkId);
        router.refresh();
      } catch (err) {
        if (handleAuth(err)) return;
        setError(
          err instanceof Error ? err.message : "Could not remove relation.",
        );
      }
    });
  }

  const grouped = DISPLAY_ORDER.map((dir) => ({
    dir,
    items: relations.filter((r) => r.direction === dir),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-3">
      <span className="text-xs font-medium text-muted-foreground">
        Relations
      </span>

      {grouped.length === 0 && !adding ? (
        <p className="text-xs text-muted-foreground">No relations yet.</p>
      ) : null}
      {grouped.length > 0 ? (
        <ul className="space-y-2">
          {grouped.map((group) => (
            <li key={group.dir} className="space-y-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {DIRECTION_LABEL[group.dir]}
              </span>
              {group.items.map((r) => (
                <div key={r.id} className="flex items-center gap-1 text-sm">
                  <Link
                    href={orgHref(`/backlog/${r.otherLevel}/${r.otherSpecId}`)}
                    className="flex-1 truncate hover:underline"
                    title={r.otherTitle}
                  >
                    {r.otherTitle}
                  </Link>
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => onRemove(r.id)}
                      disabled={pending}
                      aria-label={`Remove relation to ${r.otherTitle}`}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Start as an "Add relation" affordance; reveal the form on opt-in (see
          the "add" UX rule in CLAUDE.md). */}
      {canEdit && candidates.length > 0 ? (
        adding ? (
          <form onSubmit={onAdd} className="space-y-2">
            <Select name="direction" defaultValue="blocked_by" className="h-8">
              {RELATION_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {DIRECTION_LABEL[d]}…
                </option>
              ))}
            </Select>
            <Select name="toSpecId" defaultValue="" className="h-8">
              <option value="">Select a feature…</option>
              {candidates.map((c) => (
                <option key={c.specId} value={c.specId}>
                  {c.title}
                </option>
              ))}
            </Select>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Add relation"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
          >
            Add relation
          </Button>
        )
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
