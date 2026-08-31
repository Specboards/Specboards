/**
 * Workspace configuration: the hierarchy levels, the detail templates that
 * hang off them, the custom properties, the workflow statuses and the stage
 * gates that guard transitions between them.
 *
 * One module rather than four because they are one question asked four ways.
 * Every setting here exists at the workspace level and may be overridden per
 * product, and the same rule decides all of them: a product's own rows win if
 * it has any, otherwise it inherits the workspace's. That is why the `*In`
 * helpers all take a nullable `productId` and why an empty product-level set
 * means "inherit" rather than "nothing".
 *
 * The subtlety worth knowing before changing anything here is on the write
 * side. `replaceStatuses` has to ask which products currently override the
 * workspace default *before* it writes, because after the write the answer has
 * changed; and it has to re-home stranded work *after*, against the stages
 * that are in force once the write lands. Getting that order wrong is what
 * left items on deleted stages before, so `inheritingProductsFilter` stays
 * above the write and the re-home stays below it.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. `levelsIn` is a `DbStoreContext` member, so the store delegates that
 * one too rather than keeping a second copy. See ./context.ts.
 */

import {
  DEFAULT_STATUSES,
  isPropertyType,
  propertyKeyFromLabel,
  resolveLevels,
  resolveLevelUpdate,
  type PropertyDef,
  type PropertyEntity,
  type WorkspaceLevel,
} from "@specboards/core";

import {
  and,
  asc,
  detailTemplates,
  eq,
  featureGateCompletions,
  features,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  productSettings,
  workspaceLevels,
  workspaceProperties,
  workspaceStageGates,
  workspaceStatuses,
} from "@specboards/db";

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

import {
  asLevelMap,
  canWriteProductId,
  type DbStoreContext,
  type Tx,
} from "./context";
export async function listLevels(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  return ctx.scoped(scope, (tx) =>
    levelsIn(ctx, tx, scope!.workspaceId, productId ?? null),
  );
}

export async function updateLevels(
  ctx: DbStoreContext,
  updates: LevelUpdate[],
  scope?: WorkspaceScope,
): Promise<WorkspaceLevel[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await levelsIn(ctx, tx, ws);

    let resolved;
    try {
      resolved = resolveLevelUpdate(current, updates);
    } catch (err) {
      throw new LevelError(
        err instanceof Error ? err.message : "Invalid levels.",
      );
    }

    // A level can only be removed once nothing references it (FK aside, the
    // items would otherwise be stranded at an unknown level).
    if (resolved.removedKeys.length > 0) {
      const used = await tx
        .select({ level: features.level })
        .from(features)
        .where(
          and(
            eq(features.workspaceId, ws),
            inArray(features.level, resolved.removedKeys),
          ),
        )
        .limit(1);
      if (used[0]) {
        throw new LevelError(
          `Can't remove the "${used[0].level}" level while items still use it.`,
        );
      }
      await tx
        .delete(workspaceLevels)
        .where(
          and(
            eq(workspaceLevels.workspaceId, ws),
            inArray(workspaceLevels.key, resolved.removedKeys),
          ),
        );
    }

    for (const level of resolved.levels) {
      await tx
        .insert(workspaceLevels)
        .values({
          workspaceId: ws,
          key: level.key,
          label: level.label,
          position: level.position,
          isLeaf: level.isLeaf,
          cardFields: level.fields ?? null,
        })
        .onConflictDoUpdate({
          target: [workspaceLevels.workspaceId, workspaceLevels.key],
          set: {
            label: level.label,
            position: level.position,
            isLeaf: level.isLeaf,
            cardFields: level.fields ?? null,
          },
        });
    }
    return resolved.levels;
  });
}

export async function updateLevelFields(
  ctx: DbStoreContext,
  fields: Record<string, string[] | null>,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await levelsIn(ctx, tx, ws, target);
    const byKey = new Map(current.map((l) => [l.key, l]));
    for (const key of Object.keys(fields)) {
      if (!byKey.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    if (target) {
      // A product's override is a patch on its map, not a replacement: the
      // levels it did not mention keep whatever they were doing, inherited or
      // otherwise, so editing one level never disturbs another.
      await patchLevelMap(ctx, tx, ws, target, "cardFields", fields);
      return levelsIn(ctx, tx, ws, target);
    }
    // Upsert: a fresh workspace may still be on the unpersisted default
    // levels, so the row might not exist yet.
    for (const [key, value] of Object.entries(fields)) {
      const level = byKey.get(key)!;
      await tx
        .insert(workspaceLevels)
        .values({
          workspaceId: ws,
          key: level.key,
          label: level.label,
          position: level.position,
          isLeaf: level.isLeaf,
          cardFields: value,
        })
        .onConflictDoUpdate({
          target: [workspaceLevels.workspaceId, workspaceLevels.key],
          set: { cardFields: value },
        });
    }
    return levelsIn(ctx, tx, ws);
  });
}

export async function updateLevelTemplates(
  ctx: DbStoreContext,
  templates: Record<string, string | null>,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await levelsIn(ctx, tx, ws, target);
    const byKey = new Map(current.map((l) => [l.key, l]));
    for (const key of Object.keys(templates)) {
      if (!byKey.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    // Validate the referenced templates belong to this workspace.
    const wanted = [
      ...new Set(Object.values(templates).filter((v): v is string => !!v)),
    ];
    if (wanted.length > 0) {
      // A level may point at a template this scope can actually see: its own
      // if it has a set, otherwise the workspace default's. Validating
      // against the whole workspace would let a product assign another
      // product's template.
      const visible = new Set(
        (await listDetailTemplatesIn(ctx, tx, ws, target)).map((t) => t.id),
      );
      const known = (
        await tx
          .select({ id: detailTemplates.id })
          .from(detailTemplates)
          .where(
            and(
              eq(detailTemplates.workspaceId, ws),
              inArray(detailTemplates.id, wanted),
            ),
          )
      ).filter((t) => visible.has(t.id));
      const knownIds = new Set(known.map((t) => t.id));
      for (const id of wanted) {
        if (!knownIds.has(id))
          throw new LevelError(`Unknown detail template: ${id}`);
      }
    }
    if (target) {
      await patchLevelMap(ctx, tx, ws, target, "levelTemplates", templates);
      return levelsIn(ctx, tx, ws, target);
    }
    for (const [key, value] of Object.entries(templates)) {
      const level = byKey.get(key)!;
      await tx
        .insert(workspaceLevels)
        .values({
          workspaceId: ws,
          key: level.key,
          label: level.label,
          position: level.position,
          isLeaf: level.isLeaf,
          cardFields: level.fields ?? null,
          detailTemplateId: value,
        })
        .onConflictDoUpdate({
          target: [workspaceLevels.workspaceId, workspaceLevels.key],
          set: { detailTemplateId: value },
        });
    }
    return levelsIn(ctx, tx, ws);
  });
}

export async function listDetailTemplates(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<DetailTemplate[]> {
  return ctx.scoped(scope, async (tx) =>
    listDetailTemplatesIn(ctx, tx, scope!.workspaceId, productId ?? null),
  );
}

export async function createDetailTemplate(
  ctx: DbStoreContext,
  input: DetailTemplateInput,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<DetailTemplate> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const name = input.name.trim();
    if (!name) throw new DetailTemplateError("Template name is required.");
    const [row] = await tx
      .insert(detailTemplates)
      .values({
        workspaceId: scope!.workspaceId,
        productId: target,
        name,
        body: input.body ?? "",
      })
      // Names are unique per scope (two partial indexes, see migration 0065),
      // so drizzle needs the predicate to pick the right one.
      .onConflictDoNothing(
        target
          ? {
              target: [
                detailTemplates.workspaceId,
                detailTemplates.productId,
                detailTemplates.name,
              ],
              where: isNotNull(detailTemplates.productId),
            }
          : {
              target: [detailTemplates.workspaceId, detailTemplates.name],
              where: isNull(detailTemplates.productId),
            },
      )
      .returning({
        id: detailTemplates.id,
        name: detailTemplates.name,
        body: detailTemplates.body,
      });
    if (!row)
      throw new DetailTemplateError(
        `A template named "${name}" already exists.`,
      );
    return row;
  });
}

export async function updateDetailTemplate(
  ctx: DbStoreContext,
  id: string,
  patch: DetailTemplatePatch,
  scope?: WorkspaceScope,
): Promise<DetailTemplate> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new DetailTemplateError("Template name is required.");
      set.name = name;
    }
    if (patch.body !== undefined) set.body = patch.body;
    const [row] = await tx
      .update(detailTemplates)
      .set(set)
      .where(
        and(eq(detailTemplates.id, id), eq(detailTemplates.workspaceId, ws)),
      )
      .returning({
        id: detailTemplates.id,
        name: detailTemplates.name,
        body: detailTemplates.body,
      });
    if (!row) throw new DetailTemplateError(`Unknown template: ${id}`);
    return row;
  });
}

export async function deleteDetailTemplate(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    // workspace_levels.detail_template_id is ON DELETE SET NULL, so pointing
    // levels fall back to a blank body automatically.
    const deleted = await tx
      .delete(detailTemplates)
      .where(
        and(
          eq(detailTemplates.id, id),
          eq(detailTemplates.workspaceId, scope!.workspaceId),
        ),
      )
      .returning({ id: detailTemplates.id });
    if (!deleted[0]) throw new DetailTemplateError(`Unknown template: ${id}`);
  });
}

export async function listProperties(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  entity?: PropertyEntity,
  productId?: string | null,
): Promise<PropertyDef[]> {
  return ctx.scoped(scope, (tx) =>
    propertiesIn(ctx, tx, scope!.workspaceId, entity, productId ?? null),
  );
}

export async function listPropertiesUnion(
  ctx: DbStoreContext,
  scope: WorkspaceScope | undefined,
  productIds: string[] | null,
  entity?: PropertyEntity,
): Promise<PropertyDef[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const fallback = await propertiesIn(ctx, tx, ws, entity, null);
    if (!productIds || productIds.length === 0) return fallback;

    // Same reasoning as the stage union: a board spanning products should not
    // drop a column because only one product defines it. Deduplicated by key,
    // default first, so a product that redefines a key the workspace already
    // uses does not produce two columns claiming the same field.
    const merged = [...fallback];
    const seen = new Set(fallback.map((p) => `${p.entity}:${p.key}`));
    for (const productId of productIds) {
      for (const prop of await propertiesIn(ctx, tx, ws, entity, productId)) {
        const id = `${prop.entity}:${prop.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(prop);
      }
    }
    return merged;
  });
}

export async function listStatuses(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  return ctx.scoped(scope, async (tx) =>
    statusesIn(ctx, tx, scope!.workspaceId, productId ?? null),
  );
}

export async function listStatusesUnion(
  ctx: DbStoreContext,
  scope: WorkspaceScope | undefined,
  productIds: string[] | null,
): Promise<WorkspaceStatus[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const fallback = await statusesIn(ctx, tx, ws, null);
    if (!productIds || productIds.length === 0) return fallback;

    // The default's order is the spine, so a board that spans products still
    // reads left-to-right the way the workspace laid it out. Stages only some
    // product defines are appended after it rather than interleaved, because
    // there is no defensible way to order a stage the default has never seen
    // against one it has.
    const merged: WorkspaceStatus[] = [...fallback];
    const seen = new Set(fallback.map((s) => s.key));
    for (const productId of productIds) {
      for (const stage of await statusesIn(ctx, tx, ws, productId)) {
        if (seen.has(stage.key)) continue;
        seen.add(stage.key);
        merged.push({ ...stage, position: merged.length });
      }
    }
    return merged.map((s, i) => ({ ...s, position: i }));
  });
}

export async function replaceStatuses(
  ctx: DbStoreContext,
  stages: StatusStageInput[],
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;

    // Which items this edit is allowed to touch. Editing a product's stages
    // must not re-home another product's work, and editing the workspace
    // default must only reach the products that actually follow it: a product
    // with its own stage set is unaffected by a change to the default, so
    // sweeping its items to a stage it does not have would be a bug with no
    // way back.
    //
    // Read before the write below, because for the workspace default it asks
    // which products override, and an empty `stages` deletes rows this query
    // must not have seen yet.
    const productScope = target
      ? eq(features.productId, target)
      : await inheritingProductsFilter(ctx, tx, ws);

    // Replace this scope's stage set wholesale (positions follow the order
    // given). An empty list is how a scope gives up its own set: a product
    // falls back to the workspace default, and the default falls back to the
    // built-in vocabulary.
    await tx
      .delete(workspaceStatuses)
      .where(
        and(
          eq(workspaceStatuses.workspaceId, ws),
          target
            ? eq(workspaceStatuses.productId, target)
            : isNull(workspaceStatuses.productId),
        ),
      );
    if (stages.length > 0) {
      await tx.insert(workspaceStatuses).values(
        stages.map((s, i) => ({
          workspaceId: ws,
          productId: target,
          key: s.key,
          label: s.label,
          position: i,
        })),
      );
    }

    // What is in force *now*, which is not the same as what was just passed
    // in. On a revert `stages` is empty, and the answer is whatever this
    // scope has fallen back to. Deriving these from the incoming list instead
    // is what used to strand items: an empty list made every key invalid and
    // the fallback `undefined`, so the re-home below quietly updated nothing
    // but `updatedAt` and left the work sitting in a stage the board no
    // longer draws.
    const effective = await statusesIn(ctx, tx, ws, target);
    const keys =
      effective.length > 0
        ? effective.map((s) => s.key)
        : DEFAULT_STATUSES.filter((s) => s !== "archived");
    const fallback = keys[0]!;
    // `archived` is a system status and always remains valid so archived
    // items aren't swept back onto the board.
    const validKeys = new Set([...keys, "archived"]);

    // Re-home any items whose current status is no longer a stage.
    const used = await tx
      .selectDistinct({ status: features.status })
      .from(features)
      .where(and(eq(features.workspaceId, ws), productScope));
    const orphaned = used.map((u) => u.status).filter((s) => !validKeys.has(s));
    if (orphaned.length > 0) {
      await tx
        .update(features)
        .set({ status: fallback, updatedAt: new Date() })
        .where(
          and(
            eq(features.workspaceId, ws),
            productScope,
            inArray(features.status, orphaned),
          ),
        );
    }

    // Drop stage gates whose stage was removed (renames keep the key, so only
    // deletions strand gates). Their completions cascade with the gate rows,
    // so a removed-then-recreated stage doesn't resurrect stale checklists.
    // Scoped the same way: a product's gates guard a product's stages.
    const gateScope = target
      ? eq(workspaceStageGates.productId, target)
      : isNull(workspaceStageGates.productId);
    const usedStages = await tx
      .selectDistinct({ stageKey: workspaceStageGates.stageKey })
      .from(workspaceStageGates)
      .where(and(eq(workspaceStageGates.workspaceId, ws), gateScope));
    const orphanedGateStages = usedStages
      .map((r) => r.stageKey)
      .filter((s) => !validKeys.has(s));
    if (orphanedGateStages.length > 0) {
      await tx
        .delete(workspaceStageGates)
        .where(
          and(
            eq(workspaceStageGates.workspaceId, ws),
            gateScope,
            inArray(workspaceStageGates.stageKey, orphanedGateStages),
          ),
        );
    }

    return statusesIn(ctx, tx, ws, target);
  });
}

export async function listStageGates(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<StageGate[]> {
  return ctx.scoped(scope, async (tx) =>
    stageGatesIn(ctx, tx, scope!.workspaceId, productId ?? null),
  );
}

export async function replaceStageGates(
  ctx: DbStoreContext,
  gates: StageGateInput[],
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<StageGate[]> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    // Every read and write below is confined to this scope's rows, so kept
    // gates keep their ids (and therefore their per-item completions) and a
    // product's edit never deletes the workspace default's checklists.
    const gateScope = target
      ? eq(workspaceStageGates.productId, target)
      : isNull(workspaceStageGates.productId);
    // Position is per-stage: the nth gate listed for a given stage.
    const perStage = new Map<string, number>();
    const resolved = gates.map((g) => {
      const pos = perStage.get(g.stageKey) ?? 0;
      perStage.set(g.stageKey, pos + 1);
      return {
        id: g.id,
        stageKey: g.stageKey,
        label: g.label,
        position: pos,
      };
    });

    // Reconcile against the existing set so kept gates (matched by id) retain
    // their per-item completions; only removed gates cascade-delete theirs.
    const existing = await tx
      .select({ id: workspaceStageGates.id })
      .from(workspaceStageGates)
      .where(and(eq(workspaceStageGates.workspaceId, ws), gateScope));
    const existingIds = new Set(existing.map((r) => r.id));
    const keepIds = new Set(
      resolved
        .map((g) => g.id)
        .filter((id): id is string => !!id && existingIds.has(id)),
    );

    // Delete gates that are gone from the new set.
    const toDelete = [...existingIds].filter((id) => !keepIds.has(id));
    if (toDelete.length > 0) {
      await tx
        .delete(workspaceStageGates)
        .where(
          and(
            eq(workspaceStageGates.workspaceId, ws),
            gateScope,
            inArray(workspaceStageGates.id, toDelete),
          ),
        );
    }

    // Update kept gates in place; insert new ones.
    for (const g of resolved) {
      if (g.id && keepIds.has(g.id)) {
        await tx
          .update(workspaceStageGates)
          .set({ stageKey: g.stageKey, label: g.label, position: g.position })
          .where(
            and(
              eq(workspaceStageGates.id, g.id),
              eq(workspaceStageGates.workspaceId, ws),
            ),
          );
      } else {
        await tx.insert(workspaceStageGates).values({
          workspaceId: ws,
          productId: target,
          stageKey: g.stageKey,
          label: g.label,
          position: g.position,
        });
      }
    }

    return stageGatesIn(ctx, tx, ws, target);
  });
}

export async function listGateCompletions(
  ctx: DbStoreContext,
  specId: string,
  scope?: WorkspaceScope,
): Promise<string[]> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const feat = await tx
      .select({ id: features.id })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
    if (!feat[0]) return [];
    const rows = await tx
      .select({ gateId: featureGateCompletions.gateId })
      .from(featureGateCompletions)
      .where(
        and(
          eq(featureGateCompletions.featureId, feat[0].id),
          eq(featureGateCompletions.workspaceId, ws),
        ),
      );
    return rows.map((r) => r.gateId);
  });
}

export async function setGateCompletion(
  ctx: DbStoreContext,
  specId: string,
  gateId: string,
  completed: boolean,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const feat = await tx
      .select({ id: features.id, productId: features.productId })
      .from(features)
      .where(and(eq(features.specId, specId), eq(features.workspaceId, ws)));
    if (!feat[0]) throw new StageGateError(`Unknown feature: ${specId}`);
    const access = await ctx.accessIn(tx, scope!);
    if (!canWriteProductId(access, feat[0].productId)) {
      throw new StageGateError(
        "Your role does not permit editing this product.",
      );
    }
    // The gate must exist in this workspace (RLS also enforces the tenant).
    const gate = await tx
      .select({ id: workspaceStageGates.id })
      .from(workspaceStageGates)
      .where(
        and(
          eq(workspaceStageGates.id, gateId),
          eq(workspaceStageGates.workspaceId, ws),
        ),
      );
    if (!gate[0]) throw new StageGateError("Unknown stage gate.");

    if (completed) {
      await tx
        .insert(featureGateCompletions)
        .values({
          workspaceId: ws,
          featureId: feat[0].id,
          gateId,
          completedBy: scope!.userId,
        })
        .onConflictDoNothing({
          target: [
            featureGateCompletions.featureId,
            featureGateCompletions.gateId,
          ],
        });
    } else {
      await tx
        .delete(featureGateCompletions)
        .where(
          and(
            eq(featureGateCompletions.featureId, feat[0].id),
            eq(featureGateCompletions.gateId, gateId),
            eq(featureGateCompletions.workspaceId, ws),
          ),
        );
    }
  });
}

export async function createProperty(
  ctx: DbStoreContext,
  input: PropertyInput,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<PropertyDef> {
  const target = productId ?? null;
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const label = input.label.trim();
    if (!label) throw new PropertyError("Property label is required.");
    if (!isPropertyType(input.type)) {
      throw new PropertyError(`Unknown property type: ${String(input.type)}`);
    }
    const entity: PropertyEntity = input.entity ?? "item";
    // Keys and positions are scoped per entity, so an item and a release
    // property can share a key and each ordering starts at 0.
    // Uniqueness and ordering are per scope: two products may each define a
    // "Risk", and each list starts at position 0. Resolved against this
    // scope's own rows, not the inherited ones, so adding the first property
    // to a product does not have to dodge the workspace's keys.
    const existing = (await ownPropertiesIn(ctx, tx, ws, target)).filter(
      (p) => p.entity === entity,
    );
    const key = propertyKeyFromLabel(
      label,
      new Set(existing.map((p) => p.key)),
    );
    // Releases have no hierarchy level, so a release property is never
    // level-scoped; item properties honor the requested levels.
    const levels =
      entity === "release"
        ? null
        : await normalizeLevels(ctx, tx, ws, input.levels);
    const position = existing.reduce((m, p) => Math.max(m, p.position), -1) + 1;
    const [row] = await tx
      .insert(workspaceProperties)
      .values({
        workspaceId: ws,
        productId: target,
        key,
        label,
        type: input.type,
        entity,
        options: normalizeOptions(input.type, input.options),
        levels,
        position,
      })
      .returning();
    if (!row) throw new PropertyError("Failed to create property.");
    return toPropertyDef(row);
  });
}

export async function updateProperty(
  ctx: DbStoreContext,
  id: string,
  patch: PropertyPatch,
  scope?: WorkspaceScope,
): Promise<PropertyDef> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const current = await tx.query.workspaceProperties.findFirst({
      where: and(
        eq(workspaceProperties.id, id),
        eq(workspaceProperties.workspaceId, ws),
      ),
    });
    if (!current) throw new PropertyError(`Unknown property: ${id}`);
    const set: Record<string, unknown> = {};
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (!label) throw new PropertyError("Property label is required.");
      set.label = label;
    }
    if (patch.options !== undefined) {
      set.options = normalizeOptions(
        current.type as PropertyDef["type"],
        patch.options,
      );
    }
    if (patch.levels !== undefined) {
      set.levels = await normalizeLevels(ctx, tx, ws, patch.levels);
    }
    if (patch.position !== undefined) set.position = patch.position;
    if (Object.keys(set).length === 0) return toPropertyDef(current);
    const [row] = await tx
      .update(workspaceProperties)
      .set(set)
      .where(
        and(
          eq(workspaceProperties.id, id),
          eq(workspaceProperties.workspaceId, ws),
        ),
      )
      .returning();
    if (!row) throw new PropertyError(`Unknown property: ${id}`);
    return toPropertyDef(row);
  });
}

export async function deleteProperty(
  ctx: DbStoreContext,
  id: string,
  scope?: WorkspaceScope,
): Promise<void> {
  await ctx.scoped(scope, async (tx) => {
    const deleted = await tx
      .delete(workspaceProperties)
      .where(
        and(
          eq(workspaceProperties.id, id),
          eq(workspaceProperties.workspaceId, scope!.workspaceId),
        ),
      )
      .returning({ id: workspaceProperties.id });
    if (!deleted[0]) throw new PropertyError(`Unknown property: ${id}`);
  });
}

/**
 * The workspace's hierarchy levels, ordered top → leaf (default if none),
 * with one product's overrides laid over them.
 *
 * The hierarchy itself is always workspace-wide: it is Settings > Hierarchy,
 * not a Cards setting, and per-product levels would break rollup, portfolio
 * releases, and the `level` key `whoami` publishes for external agents. What
 * a product may override is what each level *shows*: its built-in fields and
 * its default detail template. Those live in level-keyed maps on the
 * product's settings row, since there is no per-product level row to put them
 * on.
 *
 * A level absent from a map inherits; a level present with `null` overrides
 * to "all fields" / "no template". That is what makes adding a level safe:
 * the new level is in nobody's map, so every product inherits it rather than
 * silently losing fields on it.
 */
export async function levelsIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string | null = null,
): Promise<WorkspaceLevel[]> {
  const rows = await tx
    .select({
      key: workspaceLevels.key,
      label: workspaceLevels.label,
      position: workspaceLevels.position,
      isLeaf: workspaceLevels.isLeaf,
      cardFields: workspaceLevels.cardFields,
      detailTemplateId: workspaceLevels.detailTemplateId,
    })
    .from(workspaceLevels)
    .where(eq(workspaceLevels.workspaceId, workspaceId))
    .orderBy(asc(workspaceLevels.position));

  const overrides = productId
    ? await levelOverridesIn(ctx, tx, workspaceId, productId)
    : { cardFields: {}, levelTemplates: {} };

  return resolveLevels(
    rows.map(({ cardFields, detailTemplateId, key, ...rest }) => ({
      ...rest,
      key,
      fields: hasOwn(overrides.cardFields, key)
        ? overrides.cardFields[key]!
        : Array.isArray(cardFields)
          ? (cardFields as string[])
          : null,
      detailTemplateId: hasOwn(overrides.levelTemplates, key)
        ? overrides.levelTemplates[key]!
        : (detailTemplateId ?? null),
    })),
  );
}

/** One product's level-keyed Cards overrides, empty when it has none. */
async function levelOverridesIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string,
): Promise<{
  cardFields: Record<string, string[] | null>;
  levelTemplates: Record<string, string | null>;
}> {
  const [row] = await tx
    .select({
      cardFields: productSettings.cardFields,
      levelTemplates: productSettings.levelTemplates,
    })
    .from(productSettings)
    .where(
      and(
        eq(productSettings.workspaceId, workspaceId),
        eq(productSettings.productId, productId),
      ),
    )
    .limit(1);
  return {
    cardFields: asLevelMap<string[] | null>(row?.cardFields),
    levelTemplates: asLevelMap<string | null>(row?.levelTemplates),
  };
}

async function listDetailTemplatesIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  target: string | null,
): Promise<DetailTemplate[]> {
  {
    const rows = await tx
      .select({
        id: detailTemplates.id,
        name: detailTemplates.name,
        body: detailTemplates.body,
        productId: detailTemplates.productId,
      })
      .from(detailTemplates)
      .where(
        and(
          eq(detailTemplates.workspaceId, workspaceId),
          target
            ? or(
                eq(detailTemplates.productId, target),
                isNull(detailTemplates.productId),
              )
            : isNull(detailTemplates.productId),
        ),
      )
      .orderBy(asc(detailTemplates.name));
    // Own set if there is one, otherwise the workspace default's, matching
    // how every other per-product Cards setting resolves.
    const own = target ? rows.filter((r) => r.productId === target) : [];
    const source =
      own.length > 0 ? own : rows.filter((r) => r.productId === null);
    return source.map(({ id, name, body }) => ({ id, name, body }));
  }
}

/** Validate a property's level list against the workspace hierarchy. */
async function normalizeLevels(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  levels: string[] | null | undefined,
): Promise<string[] | null> {
  if (levels == null) return null;
  const known = new Set((await levelsIn(ctx, tx, ws)).map((l) => l.key));
  const cleaned = [...new Set(levels.map((l) => l.trim()).filter(Boolean))];
  for (const key of cleaned) {
    if (!known.has(key)) throw new PropertyError(`Unknown level: ${key}`);
  }
  return cleaned;
}

/**
 * Only the rows this scope owns, ignoring anything it would inherit. Used
 * where the question is "what has this scope defined" rather than "what does
 * it show": key allocation, position allocation, and telling an override
 * apart from an inheritance in the settings UI.
 */
async function ownPropertiesIn(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  productId: string | null,
): Promise<PropertyDef[]> {
  const rows = await tx
    .select()
    .from(workspaceProperties)
    .where(
      and(
        eq(workspaceProperties.workspaceId, ws),
        productId
          ? eq(workspaceProperties.productId, productId)
          : isNull(workspaceProperties.productId),
      ),
    )
    .orderBy(
      asc(workspaceProperties.position),
      asc(workspaceProperties.createdAt),
    );
  return rows.map(toPropertyDef);
}

/**
 * Merge a patch into one of a product's level-keyed override maps, creating
 * the settings row if the product has none yet. Keys present in the patch are
 * written (including an explicit null, which is an override to the built-in
 * behaviour); keys absent from it are untouched and go on inheriting.
 */
async function patchLevelMap<T>(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string,
  column: "cardFields" | "levelTemplates",
  patch: Record<string, T>,
): Promise<void> {
  const existing = await levelOverridesIn(ctx, tx, workspaceId, productId);
  const merged = { ...(existing[column] as Record<string, unknown>), ...patch };
  const written = await tx
    .insert(productSettings)
    .values({ workspaceId, productId, [column]: merged })
    .onConflictDoUpdate({
      target: [productSettings.workspaceId, productSettings.productId],
      targetWhere: isNotNull(productSettings.productId),
      set: { [column]: merged, updatedAt: new Date() },
    })
    .returning({ id: productSettings.id });
  // Same reason as setTransitionMode: a write RLS drops silently matches zero
  // rows and would otherwise be reported as a save.
  if (written.length === 0) {
    throw new Error(
      `Product ${productId} not found while saving its Cards settings.`,
    );
  }
}

/**
 * One scope's property definitions: the product's own set if it has defined
 * one, otherwise the workspace default's.
 *
 * A product narrowing its set only stops properties being *rendered*. The
 * values stay in `features.custom_fields`, so a key the current definitions
 * do not list is expected rather than corrupt, and re-adding the property
 * brings its values back. Deleting on de-scope would mean an admin tidying a
 * settings list destroys work with no way to undo it.
 */
async function propertiesIn(
  ctx: DbStoreContext,
  tx: Tx,
  ws: string,
  entity?: PropertyEntity,
  productId: string | null = null,
): Promise<PropertyDef[]> {
  const rows = await tx
    .select()
    .from(workspaceProperties)
    .where(
      and(
        eq(workspaceProperties.workspaceId, ws),
        entity ? eq(workspaceProperties.entity, entity) : undefined,
        productId
          ? or(
              eq(workspaceProperties.productId, productId),
              isNull(workspaceProperties.productId),
            )
          : isNull(workspaceProperties.productId),
      ),
    )
    .orderBy(
      asc(workspaceProperties.position),
      asc(workspaceProperties.createdAt),
    );
  const own = productId ? rows.filter((r) => r.productId === productId) : [];
  const source =
    own.length > 0 ? own : rows.filter((r) => r.productId === null);
  return source.map(toPropertyDef);
}

/**
 * One scope's gates: the product's own if it has defined any, otherwise the
 * workspace default's. Gates follow stages because a gate guards a stage key,
 * and a product that has taken over its board columns has taken over the
 * checklists on them too.
 */
async function stageGatesIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string | null,
): Promise<StageGate[]> {
  const rows = await tx
    .select()
    .from(workspaceStageGates)
    .where(
      and(
        eq(workspaceStageGates.workspaceId, workspaceId),
        productId
          ? or(
              eq(workspaceStageGates.productId, productId),
              isNull(workspaceStageGates.productId),
            )
          : isNull(workspaceStageGates.productId),
      ),
    )
    .orderBy(
      asc(workspaceStageGates.stageKey),
      asc(workspaceStageGates.position),
    );
  const own = productId ? rows.filter((r) => r.productId === productId) : [];
  const source =
    own.length > 0 ? own : rows.filter((r) => r.productId === null);
  return source.map((r) => ({
    id: r.id,
    stageKey: r.stageKey,
    label: r.label,
    position: r.position,
  }));
}

/**
 * One scope's stages: the product's own set if it has defined one, otherwise
 * the workspace default. Set-level rather than row-level inheritance, so a
 * product either owns its board columns or follows the workspace; a partial
 * override would multiply the resolution rules for no proven demand.
 */
async function statusesIn(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string | null,
): Promise<WorkspaceStatus[]> {
  const rows = await tx
    .select()
    .from(workspaceStatuses)
    .where(
      and(
        eq(workspaceStatuses.workspaceId, workspaceId),
        productId
          ? or(
              eq(workspaceStatuses.productId, productId),
              isNull(workspaceStatuses.productId),
            )
          : isNull(workspaceStatuses.productId),
      ),
    )
    .orderBy(asc(workspaceStatuses.position));
  const own = productId ? rows.filter((r) => r.productId === productId) : [];
  const source =
    own.length > 0 ? own : rows.filter((r) => r.productId === null);
  return source.map((r) => ({
    key: r.key,
    label: r.label,
    position: r.position,
  }));
}

/**
 * A filter matching the items governed by the workspace default: those in a
 * product that has not defined its own stages, plus those with no product at
 * all (legacy rows the app no longer creates).
 */
async function inheritingProductsFilter(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
) {
  const overriding = await tx
    .selectDistinct({ productId: workspaceStatuses.productId })
    .from(workspaceStatuses)
    .where(
      and(
        eq(workspaceStatuses.workspaceId, workspaceId),
        isNotNull(workspaceStatuses.productId),
      ),
    );
  const ids = overriding
    .map((r) => r.productId)
    .filter((id): id is string => id !== null);
  return ids.length > 0
    ? or(isNull(features.productId), not(inArray(features.productId, ids)))
    : undefined;
}

/**
 * Whether a level-keyed override map mentions this level at all. A `hasOwn`
 * check rather than a truthiness or undefined one, because the maps use `null`
 * to mean "override to the built-in behaviour", which is a different answer
 * from "not mentioned, so inherit".
 */
function hasOwn<T>(map: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Options only make sense for select/multiselect; other types store none. */
function normalizeOptions(
  type: PropertyDef["type"],
  options: string[] | undefined,
): string[] {
  if (type !== "select" && type !== "multiselect") return [];
  return [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
}

/** Normalize a workspace_properties row into the UI's PropertyDef. */
function toPropertyDef(row: {
  id: string;
  key: string;
  label: string;
  type: string;
  entity: string;
  options: unknown;
  levels: unknown;
  position: number;
}): PropertyDef {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type as PropertyDef["type"],
    entity: row.entity as PropertyEntity,
    options: Array.isArray(row.options) ? (row.options as string[]) : [],
    levels: Array.isArray(row.levels) ? (row.levels as string[]) : null,
    position: row.position,
  };
}
