"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";

import {
  TAG_IMPORT_MAX_BYTES,
  TAG_IMPORT_TEMPLATE,
  type TagImportAction,
  type TagImportPlan,
} from "@specboards/core";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { importTags } from "@/lib/api-client/tags";

/**
 * Bulk upload: a CSV of tags to add, or of renames to apply.
 *
 * Nothing is written until a preview has been shown and approved. A rename in
 * this list rewrites the tag on every item that carries it, and a merge takes
 * two tags down to one; both are the kind of change you want to have seen
 * spelled out first, and a mis-shaped file (a stray header, a tag that does not
 * exist, a name with a comma in it) is far easier to understand as an annotated
 * table than as an error after the fact.
 *
 * The preview is advisory, not a contract. The server re-plans the same file
 * against the live registry when Apply runs, so a tag somebody else added in
 * between changes the outcome rather than breaking the run partway through.
 *
 * Both ways in are offered because both happen: a taxonomy maintained in a
 * spreadsheet arrives as a file, and a handful of renames typed out of a
 * meeting arrives as paste.
 */
export function TagImportPanel({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState("");
  const [plan, setPlan] = useState<TagImportPlan | null>(null);
  const [pending, startTransition] = useTransition();

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Let the same file be chosen again after a failure; without this the input
    // holds the old value and the change event never fires a second time.
    e.target.value = "";
    if (!file) return;
    if (file.size > TAG_IMPORT_MAX_BYTES) {
      toast.error(
        `That file is too large. Uploads are limited to ${Math.round(TAG_IMPORT_MAX_BYTES / 1024)} KB.`,
      );
      return;
    }
    startTransition(async () => {
      const text = await file.text();
      setCsv(text);
      setPlan(null);
      await preview(text);
    });
  }

  async function preview(text: string) {
    try {
      const { plan: next } = await importTags(text, false);
      setPlan(next);
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      toast.error(err instanceof Error ? err.message : "Could not read that.");
    }
  }

  function onPreview() {
    if (csv.trim() === "") return;
    startTransition(async () => {
      await preview(csv);
    });
  }

  function onApply() {
    startTransition(async () => {
      try {
        const { plan: ran, applied } = await importTags(csv, true);
        const failed = (applied ?? []).filter((a) => !a.ok);
        const done = (applied ?? []).length - failed.length;
        if (failed.length > 0) {
          toast.warning(
            `Applied ${done} of ${done + failed.length} changes. ${failed.length} failed.`,
          );
          // Keep the panel open on a partial failure so the rows that did not
          // land are still readable next to the file that produced them.
          setPlan(ran);
        } else {
          toast.success(
            done === 0
              ? "Nothing to change: every row already matched the registry."
              : `Applied ${done} ${done === 1 ? "change" : "changes"}`,
          );
          onDone();
        }
        router.refresh();
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Import failed.");
      }
    });
  }

  return (
    <section className="space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Bulk upload</h4>
        <p className="text-xs text-muted-foreground">
          One tag per line to add tags. Two columns to rename one:{" "}
          <code className="rounded bg-muted px-1">SF,Salesforce</code> renames{" "}
          <code className="rounded bg-muted px-1">SF</code> and re-tags every
          item that carried it. A header row is detected and skipped.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={onFile}
          className="sr-only"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => fileRef.current?.click()}
        >
          <Upload aria-hidden />
          Choose CSV
        </Button>
        <TemplateLink />
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Or paste the rows
        </span>
        <Textarea
          rows={5}
          value={csv}
          spellCheck={false}
          placeholder={TAG_IMPORT_TEMPLATE}
          onChange={(e) => {
            setCsv(e.target.value);
            // The preview describes the text it was computed from, so it is
            // dropped the moment that text changes rather than sitting there
            // describing something else.
            setPlan(null);
          }}
          className="font-mono text-xs"
        />
      </label>

      {plan ? <PlanTable plan={plan} /> : null}

      <div className="flex flex-wrap gap-2">
        {plan ? (
          <Button
            type="button"
            size="sm"
            onClick={onApply}
            disabled={pending || plan.writes === 0}
          >
            {pending
              ? "Applying…"
              : `Apply ${plan.writes} ${plan.writes === 1 ? "change" : "changes"}`}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={onPreview}
            disabled={pending || csv.trim() === ""}
          >
            {pending ? "Reading…" : "Preview"}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/**
 * A download of the example file.
 *
 * Built as a blob at click time rather than served from `public/` because the
 * example is one constant, shared with the placeholder text above and the
 * planner's tests; a second copy in a static file is a copy that goes stale.
 */
function TemplateLink() {
  return (
    <Button
      type="button"
      size="sm"
      variant="link"
      className="h-auto p-0 text-xs font-normal text-muted-foreground"
      onClick={() => {
        const url = URL.createObjectURL(
          new Blob([TAG_IMPORT_TEMPLATE + "\n"], { type: "text/csv" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = "tags.csv";
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      Download a template
    </Button>
  );
}

const KIND_LABEL: Record<TagImportAction["kind"], string> = {
  create: "Add",
  rename: "Rename",
  merge: "Merge",
  unchanged: "No change",
  error: "Skipped",
};

/** What the file would do, row by row, before any of it runs. */
function PlanTable({ plan }: { plan: TagImportPlan }) {
  const { counts } = plan;
  const summary = [
    counts.create > 0 ? `${counts.create} to add` : null,
    counts.rename > 0 ? `${counts.rename} to rename` : null,
    counts.merge > 0 ? `${counts.merge} to merge` : null,
    counts.unchanged > 0 ? `${counts.unchanged} unchanged` : null,
    counts.error > 0 ? `${counts.error} skipped` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      <div role="status" className="space-y-1 text-xs text-muted-foreground">
        <p>
          {plan.actions.length === 0
            ? "Nothing to import: no rows found."
            : summary.join(" · ")}
        </p>
        {counts.merge > 0 ? (
          <p>
            Merging takes two tags down to one: items carrying either end up
            carrying the survivor.
          </p>
        ) : null}
      </div>
      {plan.actions.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50">
              <tr className="text-left">
                <th className="px-2 py-1 font-medium">Line</th>
                <th className="px-2 py-1 font-medium">Action</th>
                <th className="px-2 py-1 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {plan.actions.map((action, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">
                    {action.line}
                  </td>
                  <td
                    className={
                      action.kind === "error"
                        ? "px-2 py-1 font-medium text-destructive"
                        : "px-2 py-1 font-medium"
                    }
                  >
                    {KIND_LABEL[action.kind]}
                  </td>
                  <td className="px-2 py-1">
                    <PlanDetail action={action} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function PlanDetail({ action }: { action: TagImportAction }) {
  switch (action.kind) {
    case "create":
      return <code>{action.name}</code>;
    case "rename":
    case "merge":
      return (
        <span>
          <code>{action.from}</code> to <code>{action.to}</code>
        </span>
      );
    case "unchanged":
      return (
        <span className="text-muted-foreground">
          <code>{action.name}</code> {action.reason}
        </span>
      );
    case "error":
      return <span className="text-destructive">{action.error}</span>;
  }
}
