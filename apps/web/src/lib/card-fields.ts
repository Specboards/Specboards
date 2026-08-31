import type { BoardPreferences } from "@/lib/store/types";

/**
 * Catalog of fields a board card can display. Built-in keys are fixed; custom
 * properties (admin-defined, see PropertyDef) contribute keys prefixed `cf:`.
 * Shared by the board (server render), the card component, and the customize
 * menu (client).
 */
export interface CardFieldDef {
  key: string;
  label: string;
}

export const CUSTOM_FIELD_PREFIX = "cf:";

/**
 * Built-in card fields, in their default display order.
 *
 * The `epic` and `sub` keys are historical: they are what saved board
 * preferences store, and renaming one would silently drop that field from every
 * board that had chosen it. The labels describe what the fields actually do,
 * which is name a card's children and its parent at whatever levels the
 * workspace has configured.
 */
export const BUILTIN_CARD_FIELDS: CardFieldDef[] = [
  { key: "assignee", label: "Assignee" },
  { key: "blocked", label: "Blocked badge" },
  { key: "epic", label: "Child progress" },
  { key: "sub", label: "Parent level badge" },
  { key: "tags", label: "Tags" },
  { key: "release", label: "Release" },
  { key: "github", label: "GitHub" },
];

/** Fields shown when a user hasn't customized (matches the original board). */
export const DEFAULT_CARD_FIELDS = ["blocked", "epic", "sub", "tags"];

const BUILTIN_KEYS = new Set(BUILTIN_CARD_FIELDS.map((f) => f.key));

/** The full set of selectable fields, including the workspace's custom properties. */
export function cardFieldCatalog(
  customFields: { key: string; label: string }[],
): CardFieldDef[] {
  return [
    ...BUILTIN_CARD_FIELDS,
    ...customFields.map((f) => ({
      key: `${CUSTOM_FIELD_PREFIX}${f.key}`,
      label: f.label,
    })),
  ];
}

/** Resolve the effective card fields + featured field from saved preferences. */
export function resolveCardFields(
  prefs: BoardPreferences | null,
  catalog: CardFieldDef[],
): { fields: string[]; featured: string | null } {
  const known = new Set(catalog.map((f) => f.key));
  const chosen = prefs?.cardFields ?? DEFAULT_CARD_FIELDS;
  // Drop keys no longer in the catalog (e.g. a removed custom property).
  return {
    fields: chosen.filter((k) => known.has(k)),
    featured: prefs?.featured ?? null,
  };
}

/** Whether a field key is one of the built-ins (vs a `cf:` custom property). */
export function isBuiltinCardField(key: string): boolean {
  return BUILTIN_KEYS.has(key);
}

/**
 * Built-in metadata fields admins can enable/disable per hierarchy level
 * (Settings -> Cards). Name, status, parent, and release are structural and
 * always available; custom-property availability lives on the property itself
 * (PropertyDef.levels); display-only card decorations (blocked, epic, sub,
 * github) stay per-user board preferences.
 */
export const BUILTIN_METADATA_FIELDS: CardFieldDef[] = [
  { key: "assignee", label: "Assignee" },
  { key: "tags", label: "Tags" },
];

/**
 * Whether a built-in metadata field is available at a level. `available` is
 * the level's configured list (WorkspaceLevel.fields); null/undefined = all.
 */
export function isFieldAvailable(
  available: string[] | null | undefined,
  key: string,
): boolean {
  return available == null || available.includes(key);
}
