/**
 * Workspace configuration in local file mode: the hierarchy levels, the detail
 * templates that hang off them, the custom properties, the workflow statuses
 * and the stage gates that guard transitions between them.
 *
 * One module rather than four for the same reason as `db/workspace-config.ts`:
 * they are one question asked four ways. What is different here is the answer
 * to "asked of what?". In Postgres every one of these settings exists at the
 * workspace level and may be overridden per product, so that module is mostly
 * the inheritance rule. Local file mode has one repository and one product, so
 * there is nothing to inherit from and nothing to override. That is why
 * `listPropertiesUnion` and `listStatusesUnion` are one-line forwards rather
 * than merges, and why no function here takes a `productId`.
 *
 * Each setting is a JSON file under `.specboards/` (see ./paths.ts), so the
 * read/write pairs the db store gets from a query language are written out by
 * hand and stay private to this module.
 *
 * The subtlety worth knowing before changing anything here is on the write
 * side, and it is the same one the Postgres store has: `replaceStatuses` writes
 * first and then re-homes stranded work against the stages that are in force
 * once the write lands. Getting that order wrong is what left items on deleted
 * stages before. The sweep has to cover two places, because a DB-native item
 * carries its status in the items file and a spec-backed one carries its own in
 * the metadata map.
 *
 * These were methods on `LocalFileStore` and are now functions taking the store
 * as `ctx`. The bodies are unchanged; the store delegates to them so no caller
 * moved. `readLevels` is a `LocalStoreContext` member whose implementation
 * moved out with the levels it reads, so the store delegates that one too
 * rather than keeping a second copy. Same pattern as `levelsIn` on the Postgres
 * side. See ./context.ts.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_STATUSES,
  isPropertyType,
  parseRepoConfigYaml,
  propertyKeyFromLabel,
  resolveLevels,
  resolveLevelUpdate,
  terminalStatus,
  type PropertyDef,
  type PropertyEntity,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  DetailTemplateError,
  LevelError,
  PropertyError,
  StageGateError,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type LevelUpdate,
  type PropertyInput,
  type PropertyPatch,
  type StageGate,
  type StageGateInput,
  type StatusStageInput,
  type WorkspaceScope,
  type WorkspaceStatus,
} from "../types";

import { type LocalStoreContext } from "./context";
import { localPath } from "./paths";

// The hierarchy persists to `.specboards/local-levels.json`. `readLevels` is
// the context member (`loadAll` needs the leaf level); the write is only ever
// this module's business, so it stays here.

/** The configured hierarchy levels, or null when none are persisted. */
export async function readLevels(
  ctx: LocalStoreContext,
): Promise<WorkspaceLevel[] | null> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "levels"), "utf8"),
    ) as WorkspaceLevel[];
  } catch {
    return null;
  }
}

async function writeLevels(
  ctx: LocalStoreContext,
  levels: WorkspaceLevel[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "levels")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "levels"),
    JSON.stringify(levels, null, 2) + "\n",
    "utf8",
  );
}

export async function listLevels(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  // Persisted config if present, else the default hierarchy.
  return resolveLevels(await readLevels(ctx));
}

export async function updateLevels(
  ctx: LocalStoreContext,
  updates: LevelUpdate[],
  _scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const current = resolveLevels(await readLevels(ctx));
  let resolved;
  try {
    resolved = resolveLevelUpdate(current, updates);
  } catch (err) {
    throw new LevelError(
      err instanceof Error ? err.message : "Invalid levels.",
    );
  }
  if (resolved.removedKeys.length > 0) {
    const items = await ctx.readItems();
    const used = items.find((i) => resolved.removedKeys.includes(i.level));
    if (used) {
      throw new LevelError(
        `Can't remove the "${used.level}" level while items still use it.`,
      );
    }
  }
  await writeLevels(ctx, resolved.levels);
  return resolved.levels;
}

export async function updateLevelFields(
  ctx: LocalStoreContext,
  fields: Record<string, string[] | null>,
  _scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const current = resolveLevels(await readLevels(ctx));
  const known = new Set(current.map((l) => l.key));
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
  }
  const updated = current.map((l) =>
    Object.prototype.hasOwnProperty.call(fields, l.key)
      ? { ...l, fields: fields[l.key] ?? null }
      : l,
  );
  await writeLevels(ctx, updated);
  return updated;
}

// Custom properties persist to `.specboards/local-properties.json`.
async function readProperties(ctx: LocalStoreContext): Promise<PropertyDef[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "properties"), "utf8"),
    ) as PropertyDef[];
  } catch {
    return [];
  }
}

async function writeProperties(
  ctx: LocalStoreContext,
  rows: PropertyDef[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "properties")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "properties"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

export async function listProperties(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
  entity?: PropertyEntity,
): Promise<PropertyDef[]> {
  // Default `entity` for rows written before the discriminator existed.
  const rows = (await readProperties(ctx)).map((p) => ({
    ...p,
    entity: p.entity ?? "item",
  }));
  const filtered = entity ? rows.filter((p) => p.entity === entity) : rows;
  return filtered.sort((a, b) => a.position - b.position);
}

/** One product by construction, so every union is just the list itself. */
export async function listPropertiesUnion(
  ctx: LocalStoreContext,
  scope: WorkspaceScope | undefined,
  _productIds: string[] | null,
  entity?: PropertyEntity,
): Promise<PropertyDef[]> {
  return listProperties(ctx, scope, entity);
}

export async function createProperty(
  ctx: LocalStoreContext,
  input: PropertyInput,
  _scope?: WorkspaceScope,
): Promise<PropertyDef> {
  const label = input.label.trim();
  if (!label) throw new PropertyError("Property label is required.");
  if (!isPropertyType(input.type)) {
    throw new PropertyError(`Unknown property type: ${String(input.type)}`);
  }
  const entity: PropertyEntity = input.entity ?? "item";
  const rows = await readProperties(ctx);
  // Keys and positions are scoped per entity (see the db store).
  const sameEntity = rows.filter((p) => (p.entity ?? "item") === entity);
  const property: PropertyDef = {
    id: randomUUID(),
    key: propertyKeyFromLabel(label, new Set(sameEntity.map((p) => p.key))),
    label,
    type: input.type,
    entity,
    options: localNormalizeOptions(input.type, input.options),
    levels: entity === "release" ? null : (input.levels ?? null),
    position: sameEntity.reduce((m, p) => Math.max(m, p.position), -1) + 1,
  };
  await writeProperties(ctx, [...rows, property]);
  return property;
}

export async function updateProperty(
  ctx: LocalStoreContext,
  id: string,
  patch: PropertyPatch,
  _scope?: WorkspaceScope,
): Promise<PropertyDef> {
  const rows = await readProperties(ctx);
  const property = rows.find((p) => p.id === id);
  if (!property) throw new PropertyError(`Unknown property: ${id}`);
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new PropertyError("Property label is required.");
    property.label = label;
  }
  if (patch.options !== undefined) {
    property.options = localNormalizeOptions(property.type, patch.options);
  }
  if (patch.levels !== undefined) property.levels = patch.levels;
  if (patch.position !== undefined) property.position = patch.position;
  await writeProperties(ctx, rows);
  return property;
}

export async function deleteProperty(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readProperties(ctx);
  if (!rows.some((p) => p.id === id))
    throw new PropertyError(`Unknown property: ${id}`);
  await writeProperties(
    ctx,
    rows.filter((p) => p.id !== id),
  );
}

// Detail templates persist to `.specboards/local-detail-templates.json`.
async function readTemplates(
  ctx: LocalStoreContext,
): Promise<DetailTemplate[]> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "detailTemplates"), "utf8"),
    ) as DetailTemplate[];
  } catch {
    return [];
  }
}

async function writeTemplates(
  ctx: LocalStoreContext,
  rows: DetailTemplate[],
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "detailTemplates")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "detailTemplates"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );
}

export async function listDetailTemplates(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<DetailTemplate[]> {
  const rows = await readTemplates(ctx);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createDetailTemplate(
  ctx: LocalStoreContext,
  input: DetailTemplateInput,
  _scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  const name = input.name.trim();
  if (!name) throw new DetailTemplateError("Template name is required.");
  const rows = await readTemplates(ctx);
  if (rows.some((t) => t.name === name))
    throw new DetailTemplateError(`A template named "${name}" already exists.`);
  const template: DetailTemplate = {
    id: randomUUID(),
    name,
    body: input.body ?? "",
  };
  await writeTemplates(ctx, [...rows, template]);
  return template;
}

export async function updateDetailTemplate(
  ctx: LocalStoreContext,
  id: string,
  patch: DetailTemplatePatch,
  _scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  const rows = await readTemplates(ctx);
  const template = rows.find((t) => t.id === id);
  if (!template) throw new DetailTemplateError(`Unknown template: ${id}`);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new DetailTemplateError("Template name is required.");
    if (rows.some((t) => t.id !== id && t.name === name))
      throw new DetailTemplateError(
        `A template named "${name}" already exists.`,
      );
    template.name = name;
  }
  if (patch.body !== undefined) template.body = patch.body;
  await writeTemplates(ctx, rows);
  return template;
}

export async function deleteDetailTemplate(
  ctx: LocalStoreContext,
  id: string,
  _scope?: WorkspaceScope,
): Promise<void> {
  const rows = await readTemplates(ctx);
  if (!rows.some((t) => t.id === id))
    throw new DetailTemplateError(`Unknown template: ${id}`);
  await writeTemplates(
    ctx,
    rows.filter((t) => t.id !== id),
  );
  // Clear the pointer from any level that referenced it.
  const levels = resolveLevels(await readLevels(ctx));
  if (levels.some((l) => l.detailTemplateId === id)) {
    await writeLevels(
      ctx,
      levels.map((l) =>
        l.detailTemplateId === id ? { ...l, detailTemplateId: null } : l,
      ),
    );
  }
}

export async function updateLevelTemplates(
  ctx: LocalStoreContext,
  templates: Record<string, string | null>,
  _scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  const current = resolveLevels(await readLevels(ctx));
  const known = new Set(current.map((l) => l.key));
  for (const key of Object.keys(templates)) {
    if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
  }
  const templateIds = new Set((await readTemplates(ctx)).map((t) => t.id));
  for (const value of Object.values(templates)) {
    if (value && !templateIds.has(value))
      throw new LevelError(`Unknown detail template: ${value}`);
  }
  const updated = current.map((l) =>
    Object.prototype.hasOwnProperty.call(templates, l.key)
      ? { ...l, detailTemplateId: templates[l.key] ?? null }
      : l,
  );
  await writeLevels(ctx, updated);
  return updated;
}

// Statuses persist to `.specboards/local-statuses.json`.
export async function listStatuses(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<WorkspaceStatus[]> {
  try {
    const rows = JSON.parse(
      await fs.readFile(localPath(ctx.root, "statuses"), "utf8"),
    ) as WorkspaceStatus[];
    return rows
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((r, i) => ({ ...r, position: i }));
  } catch {
    return [];
  }
}

/**
 * Local file mode has one product by construction, so a cross-product board
 * is the same board and the union is just the stage list.
 */
export async function listStatusesUnion(
  ctx: LocalStoreContext,
  scope: WorkspaceScope | undefined,
  _productIds: string[] | null,
): Promise<WorkspaceStatus[]> {
  return listStatuses(ctx, scope);
}

/**
 * The status that means "finished" here: the terminal stage of the configured
 * stages, else of the repo config's vocabulary, else the built-in `done`.
 *
 * Mirrors `resolveWorkflowFor`'s layering, minus the per-product level, which
 * local mode has no way to express (one repo, one stage set). Local mode is
 * the only place the store reads `.specboards/config.yml` itself: in DB mode
 * the config is synced into the `repositories` row the DB store reads.
 */
export async function doneStatusKey(ctx: LocalStoreContext): Promise<string> {
  const stages = await listStatuses(ctx);
  const configured = terminalStatus(stages.map((s) => s.key));
  if (configured) return configured;
  try {
    const raw = await fs.readFile(
      path.join(ctx.root, ".specboards", "config.yml"),
      "utf8",
    );
    const statuses = parseRepoConfigYaml(raw)?.statuses;
    if (statuses && statuses.length >= 2) {
      const fromConfig = terminalStatus(statuses);
      if (fromConfig) return fromConfig;
    }
  } catch {
    // No config, or an unparseable one: fall through to the built-in stage.
  }
  return terminalStatus(DEFAULT_STATUSES)!;
}

export async function replaceStatuses(
  ctx: LocalStoreContext,
  stages: StatusStageInput[],
  _scope?: WorkspaceScope,
): Promise<WorkspaceStatus[]> {
  const rows: WorkspaceStatus[] = stages.map((s, i) => ({
    key: s.key,
    label: s.label,
    position: i,
  }));
  await fs.mkdir(path.dirname(localPath(ctx.root, "statuses")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "statuses"),
    JSON.stringify(rows, null, 2) + "\n",
    "utf8",
  );

  // What is in force after the write. An empty set means no stages are
  // configured, and the board falls back to the built-in vocabulary, so that
  // is what the keys below have to be measured against. `archived` stays
  // valid either way so archived items keep working.
  const effective =
    rows.length > 0
      ? rows.map((r) => r.key)
      : DEFAULT_STATUSES.filter((s) => s !== "archived");
  const fallback = effective[0]!;
  const validKeys = new Set<string>([...effective, "archived"]);

  // Re-home any item left in a stage that no longer exists, matching the db
  // store. Without this a removed stage leaves work on a board that draws no
  // column for it, reachable only by editing the JSON by hand.
  //
  // Two places hold a status here and both have to be swept: DB-native items
  // carry theirs in the items file, and a spec-backed item carries its own in
  // the metadata map. `loadAll` resolves an absent entry to the first stage,
  // so a spec that was never moved needs no row written for it.
  const items = await ctx.readItems();
  const movedItems = items.filter((i) => !validKeys.has(i.status));
  if (movedItems.length > 0) {
    for (const item of movedItems) item.status = fallback;
    await ctx.writeItems(items);
  }

  const meta = await ctx.readMetadata();
  let metaChanged = false;
  for (const entry of Object.values(meta)) {
    if (entry?.status !== undefined && !validKeys.has(entry.status)) {
      entry.status = fallback;
      metaChanged = true;
    }
  }
  if (metaChanged) await ctx.writeMetadata(meta);

  // Drop gates (and their completions) whose stage was removed, mirroring the
  // db store.
  const gates = await listStageGates(ctx);
  const kept = gates.filter((g) => validKeys.has(g.stageKey));
  if (kept.length !== gates.length) {
    await replaceStageGates(
      ctx,
      kept.map((g) => ({ id: g.id, stageKey: g.stageKey, label: g.label })),
    );
  }
  return rows;
}

// Stage gates persist to `.specboards/local-stage-gates.json`; per-item
// completions to `.specboards/local-gate-completions.json`.
export async function listStageGates(
  ctx: LocalStoreContext,
  _scope?: WorkspaceScope,
): Promise<StageGate[]> {
  try {
    const rows = JSON.parse(
      await fs.readFile(localPath(ctx.root, "stageGates"), "utf8"),
    ) as StageGate[];
    return rows
      .slice()
      .sort(
        (a, b) =>
          a.stageKey.localeCompare(b.stageKey) || a.position - b.position,
      );
  } catch {
    return [];
  }
}

export async function replaceStageGates(
  ctx: LocalStoreContext,
  gates: StageGateInput[],
  _scope?: WorkspaceScope,
): Promise<StageGate[]> {
  // Reconcile by id so kept gates retain their ids (and completions); only
  // gates dropped from the new set lose theirs.
  const existingIds = new Set((await listStageGates(ctx)).map((g) => g.id));
  const perStage = new Map<string, number>();
  const rows: StageGate[] = gates.map((g) => {
    const pos = perStage.get(g.stageKey) ?? 0;
    perStage.set(g.stageKey, pos + 1);
    const id = g.id && existingIds.has(g.id) ? g.id : randomUUID();
    return { id, stageKey: g.stageKey, label: g.label, position: pos };
  });
  const sorted = rows
    .slice()
    .sort(
      (a, b) => a.stageKey.localeCompare(b.stageKey) || a.position - b.position,
    );
  await fs.mkdir(path.dirname(localPath(ctx.root, "stageGates")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "stageGates"),
    JSON.stringify(sorted, null, 2) + "\n",
    "utf8",
  );
  // Drop completions whose gate no longer exists.
  const valid = new Set(sorted.map((r) => r.id));
  const completions = await readGateCompletions(ctx);
  let changed = false;
  for (const [specId, ids] of Object.entries(completions)) {
    const kept = ids.filter((id) => valid.has(id));
    if (kept.length !== ids.length) {
      changed = true;
      if (kept.length === 0) delete completions[specId];
      else completions[specId] = kept;
    }
  }
  if (changed) await writeGateCompletions(ctx, completions);
  return sorted;
}

async function readGateCompletions(
  ctx: LocalStoreContext,
): Promise<Record<string, string[]>> {
  try {
    return JSON.parse(
      await fs.readFile(localPath(ctx.root, "gateCompletions"), "utf8"),
    ) as Record<string, string[]>;
  } catch {
    return {};
  }
}

async function writeGateCompletions(
  ctx: LocalStoreContext,
  map: Record<string, string[]>,
): Promise<void> {
  await fs.mkdir(path.dirname(localPath(ctx.root, "gateCompletions")), {
    recursive: true,
  });
  await fs.writeFile(
    localPath(ctx.root, "gateCompletions"),
    JSON.stringify(map, null, 2) + "\n",
    "utf8",
  );
}

export async function listGateCompletions(
  ctx: LocalStoreContext,
  specId: string,
  _scope?: WorkspaceScope,
): Promise<string[]> {
  const map = await readGateCompletions(ctx);
  return map[specId] ?? [];
}

export async function setGateCompletion(
  ctx: LocalStoreContext,
  specId: string,
  gateId: string,
  completed: boolean,
  _scope?: WorkspaceScope,
): Promise<void> {
  const gates = await listStageGates(ctx);
  if (!gates.some((g) => g.id === gateId)) {
    throw new StageGateError("Unknown stage gate.");
  }
  const map = await readGateCompletions(ctx);
  const current = new Set(map[specId] ?? []);
  if (completed) current.add(gateId);
  else current.delete(gateId);
  if (current.size === 0) delete map[specId];
  else map[specId] = [...current];
  await writeGateCompletions(ctx, map);
}

/** Options only make sense for select/multiselect; other types store none. */
function localNormalizeOptions(
  type: PropertyDef["type"],
  options: string[] | undefined,
): string[] {
  if (type !== "select" && type !== "multiselect") return [];
  return [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
}
