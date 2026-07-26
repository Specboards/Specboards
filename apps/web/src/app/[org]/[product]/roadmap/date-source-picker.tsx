"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Select } from "@/components/ui/select";
import {
  RELEASE_SOURCE,
  dateSourceParam,
  type DateSource,
} from "@/lib/roadmap-timeline";

/** A `date`-typed workspace property the timeline can plot by. */
export interface DateFieldOption {
  key: string;
  label: string;
}

/**
 * Chooses where the timeline reads each end of a bar from: the release the item
 * is scheduled into, or any `date`-typed custom property.
 *
 * The selection lives in `?start=` / `?end=` rather than in saved preferences,
 * so a particular reading of the roadmap ("plotted by due date") is a link
 * someone can send. Both keys are carried by `withViewParams`, so changing a
 * filter or switching level keeps the plot you chose.
 */
export function DateSourcePicker({
  fields,
  start,
  end,
}: {
  fields: DateFieldOption[];
  start: DateSource;
  end: DateSource;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // With no date properties defined there is only one possible source, so the
  // control would be a pair of single-option selects. Hide it until the
  // workspace has something to choose between.
  if (fields.length === 0) return null;

  function onChange(which: "start" | "end", value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === RELEASE_SOURCE) next.delete(which);
    else next.set(which, value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Plot by</span>
      <label className="sr-only" htmlFor="timeline-start">
        Timeline start date field
      </label>
      <Select
        id="timeline-start"
        className="h-7 w-auto text-xs"
        value={dateSourceParam(start)}
        onChange={(e) => onChange("start", e.target.value)}
      >
        <option value={RELEASE_SOURCE}>Release start</option>
        {fields.map((f) => (
          <option key={f.key} value={`cf:${f.key}`}>
            {f.label}
          </option>
        ))}
      </Select>
      <span className="text-muted-foreground">to</span>
      <label className="sr-only" htmlFor="timeline-end">
        Timeline end date field
      </label>
      <Select
        id="timeline-end"
        className="h-7 w-auto text-xs"
        value={dateSourceParam(end)}
        onChange={(e) => onChange("end", e.target.value)}
      >
        <option value={RELEASE_SOURCE}>Release target</option>
        {fields.map((f) => (
          <option key={f.key} value={`cf:${f.key}`}>
            {f.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
