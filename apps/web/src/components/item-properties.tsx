"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  AlignLeft,
  Calendar,
  ChevronDownCircle,
  ExternalLink,
  Hash,
  Link as LinkIcon,
  List,
  Loader,
  Rocket,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { PropertyDef, PropertyType, StatusWorkflow } from "@specboard/core";

import { AuthRequiredError, patchFeature } from "@/lib/api-client";
import { StatusDot } from "@/components/status-dot";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { isFieldAvailable } from "@/lib/card-fields";
import { statusLabel, statusOptions } from "@/lib/feature-helpers";
import { cn } from "@/lib/utils";
import {
  releasesForProduct,
  type CustomFieldValue,
  type FeatureDetail,
  type ReleaseRecord,
} from "@/lib/store/types";
import type { WorkspaceMember } from "@/lib/workspace";

/** Lucide icon for each custom-property type (mirrors the Notion type menu). */
const PROPERTY_TYPE_ICON: Record<PropertyType, LucideIcon> = {
  text: AlignLeft,
  number: Hash,
  select: ChevronDownCircle,
  multiselect: List,
  date: Calendar,
  user: Users,
  url: LinkIcon,
};

/**
 * Notion-style property block shown at the top of an item's detail: one row per
 * property (icon + label on the left, an inline value control on the right).
 * Covers the built-ins (status / assignee / release / tags) and every custom
 * property that applies at this item's level.
 *
 * Saves are automatic — selects commit on change, text inputs debounce and
 * commit on blur. There is no manual save button. Shared by the full item page
 * and the flyout so both render an identical block.
 */
export function ItemProperties({
  feature,
  members = [],
  properties = [],
  releases = [],
  workflow,
  canEdit = true,
  availableFields = null,
}: {
  feature: FeatureDetail;
  members?: WorkspaceMember[];
  /** Custom properties that apply at this item's level. */
  properties?: PropertyDef[];
  releases?: ReleaseRecord[];
  workflow?: StatusWorkflow;
  canEdit?: boolean;
  /** Built-in metadata field keys available at this item's level; null = all. */
  availableFields?: string[] | null;
}) {
  const router = useRouter();
  // An item can only be scheduled into a release from its own product, or a
  // workspace-wide portfolio release. Scope the picker to those.
  const productReleases = feature.productId
    ? releasesForProduct(releases, feature.productId)
    : releases.filter((r) => r.productId === null);
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const dirtyRef = useRef(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  // Track the selected status locally so the allowed-transitions list
  // recomputes the instant it changes. The flyout keeps the same item in state
  // across an edit (it only refetches when the specId changes), so relying on a
  // refreshed `feature.status` would leave the dropdown showing the old stage's
  // transitions until the panel is closed and reopened.
  const [statusValue, setStatusValue] = useState(feature.status);

  // Re-sync when the parent hands us a different item, or fresh server truth
  // for the same one (e.g. after a refresh following a save elsewhere).
  useEffect(() => {
    setStatusValue(feature.status);
  }, [feature.status]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const show = (key: string) => isFieldAvailable(availableFields, key);

  async function save() {
    const form = formRef.current;
    if (!form) return;
    if (inFlightRef.current) {
      dirtyRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    setError(null);

    const data = new FormData(form);
    try {
      await patchFeature(feature.specId, {
        status: String(data.get("status") ?? feature.status),
        ...(productReleases.length > 0
          ? { releaseId: String(data.get("releaseId") ?? "") || null }
          : {}),
        ...(show("tags")
          ? {
              tags: String(data.get("tags") ?? "")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : {}),
        ...(members.length > 0 && show("assignee")
          ? { assigneeId: String(data.get("assigneeId") ?? "") || null }
          : {}),
        ...(properties.length > 0
          ? {
              customFields: collectCustomFields(
                properties,
                data,
                feature.customFields,
              ),
            }
          : {}),
      });
      setStatus("saved");
      router.refresh();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        router.push(
          `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
        );
        return;
      }
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      inFlightRef.current = false;
      if (dirtyRef.current) {
        dirtyRef.current = false;
        void save();
      }
    }
  }

  /** Debounced save: selects commit fast, typing settles before a request. */
  function queueSave(delay: number) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void save(), delay);
  }

  if (!canEdit) {
    return (
      <ReadOnlyProperties
        feature={feature}
        members={members}
        properties={properties}
        releases={releases}
        workflow={workflow}
        show={show}
      />
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        queueSave(0);
      }}
      onChange={() => queueSave(600)}
      onBlur={() => queueSave(0)}
      className="space-y-0.5"
    >
      <PropertyRow icon={Loader} label="Status">
        <div className="flex items-center gap-2">
          <StatusDot status={statusValue} />
          <Select
            name="status"
            value={statusValue}
            onChange={(e) => setStatusValue(e.target.value)}
            className={INLINE_SELECT}
          >
            {statusOptions(statusValue, workflow).map((s) => (
              <option key={s} value={s}>
                {statusLabel(s, workflow)}
              </option>
            ))}
          </Select>
        </div>
      </PropertyRow>

      {members.length > 0 && show("assignee") ? (
        <PropertyRow icon={Users} label="Assignee">
          <Select
            name="assigneeId"
            defaultValue={feature.assigneeId ?? ""}
            className={INLINE_SELECT}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </PropertyRow>
      ) : null}

      {productReleases.length > 0 ? (
        <PropertyRow icon={Rocket} label="Release">
          <Select
            name="releaseId"
            defaultValue={feature.releaseId ?? ""}
            className={INLINE_SELECT}
          >
            <option value="">None</option>
            {productReleases.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </PropertyRow>
      ) : null}

      {show("tags") ? (
        <PropertyRow icon={Tags} label="Tags">
          <Input
            name="tags"
            defaultValue={feature.tags.join(", ")}
            placeholder="Comma-separated"
            className={INLINE_INPUT}
          />
        </PropertyRow>
      ) : null}

      {properties.map((property) => (
        <PropertyRow
          key={property.key}
          icon={PROPERTY_TYPE_ICON[property.type]}
          label={property.label}
        >
          <CustomFieldInput
            property={property}
            value={feature.customFields[property.key] ?? null}
            members={members}
          />
        </PropertyRow>
      ))}

      {error ? <p className="pt-1 text-xs text-destructive">{error}</p> : null}
      <p
        className="h-4 pl-[9.5rem] text-[11px] text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
      </p>
    </form>
  );
}

/** Inline (borderless-until-hover) control styling, Notion-like. */
const INLINE_SELECT =
  "h-7 w-full max-w-[16rem] border-transparent bg-transparent px-2 shadow-none hover:bg-muted focus-visible:bg-muted";
const INLINE_INPUT =
  "h-7 w-full max-w-[16rem] border-transparent bg-transparent px-2 shadow-none hover:bg-muted focus-visible:bg-muted";

/** A single label/value row: fixed-width icon+label gutter, value on the right. */
function PropertyRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <div className="flex w-36 shrink-0 items-center gap-2 pt-1.5 text-sm text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="min-w-0 flex-1 py-0.5">{children}</div>
    </div>
  );
}

/** Form control for one custom property, keyed `cf:<key>` in the submitted form. */
function CustomFieldInput({
  property,
  value,
  members,
}: {
  property: PropertyDef;
  value: CustomFieldValue;
  members: WorkspaceMember[];
}) {
  const name = `cf:${property.key}`;

  if (property.type === "select" || property.type === "user") {
    const options =
      property.type === "user"
        ? members.map((m) => ({ value: m.userId, label: m.name }))
        : property.options.map((o) => ({ value: o, label: o }));
    return (
      <Select name={name} defaultValue={asString(value)} className={INLINE_SELECT}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }

  if (property.type === "number") {
    return (
      <Input
        name={name}
        type="number"
        defaultValue={typeof value === "number" ? value : ""}
        className={INLINE_INPUT}
        placeholder="Empty"
      />
    );
  }

  if (property.type === "date") {
    return (
      <Input
        name={name}
        type="date"
        defaultValue={asString(value)}
        className={INLINE_INPUT}
      />
    );
  }

  if (property.type === "url") {
    const current = asString(value);
    return (
      <div className="flex items-center gap-1">
        <Input
          name={name}
          type="url"
          inputMode="url"
          defaultValue={current}
          className={INLINE_INPUT}
          placeholder="https://…"
        />
        {current ? (
          <a
            href={current}
            target="_blank"
            rel="noopener noreferrer"
            title="Open link"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>
    );
  }

  if (property.type === "multiselect") {
    return (
      <Input
        name={name}
        placeholder="Comma-separated"
        defaultValue={Array.isArray(value) ? value.join(", ") : ""}
        className={INLINE_INPUT}
      />
    );
  }

  return (
    <Input
      name={name}
      defaultValue={asString(value)}
      className={INLINE_INPUT}
      placeholder="Empty"
    />
  );
}

/** Read-only rendering for viewers without edit access. */
function ReadOnlyProperties({
  feature,
  members,
  properties,
  releases,
  workflow,
  show,
}: {
  feature: FeatureDetail;
  members: WorkspaceMember[];
  properties: PropertyDef[];
  releases: ReleaseRecord[];
  workflow?: StatusWorkflow;
  show: (key: string) => boolean;
}) {
  const assignee = members.find((m) => m.userId === feature.assigneeId)?.name;
  const release = releases.find((r) => r.id === feature.releaseId)?.name;
  return (
    <div className="space-y-0.5">
      <PropertyRow icon={Loader} label="Status">
        <div className="flex items-center gap-2 px-2 py-1 text-sm">
          <StatusDot status={feature.status} />
          {statusLabel(feature.status, workflow)}
        </div>
      </PropertyRow>
      {show("assignee") && assignee ? (
        <PropertyRow icon={Users} label="Assignee">
          <span className="px-2 py-1 text-sm">{assignee}</span>
        </PropertyRow>
      ) : null}
      {release ? (
        <PropertyRow icon={Rocket} label="Release">
          <span className="px-2 py-1 text-sm">{release}</span>
        </PropertyRow>
      ) : null}
      {show("tags") && feature.tags.length > 0 ? (
        <PropertyRow icon={Tags} label="Tags">
          <span className="px-2 py-1 text-sm">{feature.tags.join(", ")}</span>
        </PropertyRow>
      ) : null}
      {properties.map((property) => {
        const raw = feature.customFields[property.key] ?? null;
        const text = Array.isArray(raw) ? raw.join(", ") : raw == null ? "" : String(raw);
        return (
          <PropertyRow
            key={property.key}
            icon={PROPERTY_TYPE_ICON[property.type]}
            label={property.label}
          >
            {property.type === "url" && text ? (
              <a
                href={text}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-2 py-1 text-sm text-link hover:underline"
              >
                {text}
              </a>
            ) : (
              <span
                className={cn("px-2 py-1 text-sm", !text && "text-muted-foreground")}
              >
                {text || "—"}
              </span>
            )}
          </PropertyRow>
        );
      })}
    </div>
  );
}

function asString(value: CustomFieldValue): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read custom-property values out of the form into the patch's customFields
 * map. The server replaces the whole map, so values for properties not shown
 * at this level are carried over from the current record untouched.
 */
function collectCustomFields(
  visibleProperties: PropertyDef[],
  data: FormData,
  current: Record<string, CustomFieldValue>,
): Record<string, CustomFieldValue> {
  const out: Record<string, CustomFieldValue> = { ...current };
  for (const property of visibleProperties) {
    const raw = String(data.get(`cf:${property.key}`) ?? "").trim();
    if (property.type === "number") {
      out[property.key] = raw === "" ? null : Number(raw);
    } else if (property.type === "multiselect") {
      out[property.key] = raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    } else {
      out[property.key] = raw === "" ? null : raw;
    }
  }
  return out;
}
