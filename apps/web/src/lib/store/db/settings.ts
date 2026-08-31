/**
 * Workspace settings: the transition mode, and which products override the
 * card configuration they would otherwise inherit.
 *
 * Both questions have the same shape, and it is the shape that makes this a
 * domain rather than two loose methods: a setting exists at the workspace
 * level and a product may override it, so answering "what is in force here"
 * always means fetching both rows and preferring the product's. A product row
 * that exists with a null value is an explicit "inherit", not an override,
 * which is why the product row alone cannot answer the question and why
 * `cardsOverrides` reports what is overridden separately from what is in use.
 *
 * These were methods on `DbStore` and are now functions taking the store as
 * `ctx`. The bodies are unchanged; `DbStore` delegates to them so no caller
 * moved. See ./context.ts.
 */

import { DEFAULT_TRANSITION_MODE, isTransitionMode } from "@specboards/core";

import {
  and,
  detailTemplates,
  eq,
  isNotNull,
  isNull,
  or,
  productSettings,
  workspaceProperties,
  workspaceStageGates,
  workspaceStatuses,
  workspaces,
} from "@specboards/db";

import type {
  CardsOverrides,
  TransitionMode,
  TransitionModeSettings,
  WorkspaceScope,
} from "../types";

import { asLevelMap, type DbStoreContext, type Tx } from "./context";
export async function getTransitionMode(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<TransitionMode> {
  return ctx.scoped(scope, async (tx) => {
    const resolved = await resolveTransitionMode(
      ctx,
      tx,
      scope!.workspaceId,
      productId ?? null,
    );
    if (resolved === null) {
      // Null means the workspace itself was not visible, not that it has no
      // setting: the caller was authorized against a workspace this query
      // cannot see. Reading that as "strict" is what made a failed save look
      // like a deliberate setting, so it fails loudly instead. A visible
      // workspace with no default row resolves to the built-in default
      // inside resolveTransitionMode and never reaches here.
      throw new Error(
        `Workspace ${scope!.workspaceId} not found while reading its transition mode.`,
      );
    }
    return resolved;
  });
}

export async function setTransitionMode(
  ctx: DbStoreContext,
  mode: TransitionMode | null,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<TransitionMode> {
  const target = productId ?? null;
  if (mode === null && target === null) {
    // Nothing sits below the workspace default for it to inherit from, so
    // "revert to inherited" is meaningless there. Refusing beats writing a
    // null that would make every product fall through to the built-in.
    throw new Error(
      "The workspace default transition mode cannot be set to inherited.",
    );
  }

  return ctx.scoped(scope, async (tx) => {
    // `returning()` so a zero-row write cannot be reported as a save. These
    // methods used to return `mode` unconditionally, which meant a write RLS
    // silently dropped still produced a 200 and a success toast, and the
    // setting only appeared to revert on the next full page load.
    const written = await tx
      .insert(productSettings)
      .values({
        workspaceId: scope!.workspaceId,
        productId: target,
        transitionMode: mode,
      })
      .onConflictDoUpdate({
        // Matches the partial unique indexes from migration 0064: the
        // default row is unique on workspace alone, a product row on the
        // pair, and drizzle needs the same predicate to pick the index.
        target: target
          ? [productSettings.workspaceId, productSettings.productId]
          : [productSettings.workspaceId],
        targetWhere: target
          ? isNotNull(productSettings.productId)
          : isNull(productSettings.productId),
        set: { transitionMode: mode, updatedAt: new Date() },
      })
      .returning({ id: productSettings.id });

    if (written.length === 0) {
      throw new Error(
        target
          ? `Product ${target} not found while setting its transition mode.`
          : `Workspace ${scope!.workspaceId} not found while setting its transition mode.`,
      );
    }

    // Report the mode now in force rather than the argument: setting a
    // product back to inherited returns whatever it now inherits.
    const resolved = await resolveTransitionMode(
      ctx,
      tx,
      scope!.workspaceId,
      target,
    );
    if (resolved === null) {
      throw new Error(
        `Workspace ${scope!.workspaceId} not found while setting its transition mode.`,
      );
    }
    return resolved;
  });
}

export async function cardsOverrides(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
  productId?: string | null,
): Promise<CardsOverrides> {
  const target = productId ?? null;
  const none: CardsOverrides = {
    transitionMode: false,
    stages: false,
    stageGates: false,
    properties: false,
    detailTemplates: false,
    cardFields: false,
    levelTemplates: false,
  };
  if (!target) return none;

  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [settings] = await tx
      .select({
        transitionMode: productSettings.transitionMode,
        cardFields: productSettings.cardFields,
        levelTemplates: productSettings.levelTemplates,
      })
      .from(productSettings)
      .where(
        and(
          eq(productSettings.workspaceId, ws),
          eq(productSettings.productId, target),
        ),
      )
      .limit(1);

    // "Owns at least one row" is the whole test for the set-shaped settings,
    // which is why these are existence probes rather than comparisons: a
    // product that defines the same stages as the workspace has still taken
    // them over, and will not follow the default when it next changes.
    const owns = async (
      table:
        | typeof workspaceStatuses
        | typeof workspaceStageGates
        | typeof workspaceProperties
        | typeof detailTemplates,
    ) => {
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.workspaceId, ws), eq(table.productId, target)))
        .limit(1);
      return rows.length > 0;
    };

    return {
      transitionMode: settings?.transitionMode != null,
      cardFields: Object.keys(asLevelMap(settings?.cardFields)).length > 0,
      levelTemplates:
        Object.keys(asLevelMap(settings?.levelTemplates)).length > 0,
      stages: await owns(workspaceStatuses),
      stageGates: await owns(workspaceStageGates),
      properties: await owns(workspaceProperties),
      detailTemplates: await owns(detailTemplates),
    };
  });
}

export async function listTransitionModes(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<TransitionModeSettings> {
  return ctx.scoped(scope, async (tx) => {
    const rows = await tx
      .select({
        productId: productSettings.productId,
        mode: productSettings.transitionMode,
      })
      .from(productSettings)
      .where(eq(productSettings.workspaceId, scope!.workspaceId));

    const overrides: Record<string, TransitionMode> = {};
    let workspaceDefault: TransitionMode = DEFAULT_TRANSITION_MODE;
    for (const row of rows) {
      if (!isTransitionMode(row.mode)) continue; // null = inherits; junk = ignored
      if (row.productId === null) workspaceDefault = row.mode;
      else overrides[row.productId] = row.mode;
    }
    return { workspaceDefault, overrides };
  });
}

/**
 * The transition mode in force for a product: its own override if it has one,
 * otherwise the workspace default. `null` means neither row was visible,
 * which callers treat as a broken scope rather than a configuration state.
 *
 * Both rows come back in one query because the product row alone cannot
 * answer the question: a row that exists with a null `transitionMode` is an
 * explicit "inherit", not an override.
 */
async function resolveTransitionMode(
  ctx: DbStoreContext,
  tx: Tx,
  workspaceId: string,
  productId: string | null,
): Promise<TransitionMode | null> {
  const rows = await tx
    .select({
      productId: productSettings.productId,
      mode: productSettings.transitionMode,
    })
    .from(productSettings)
    .where(
      and(
        eq(productSettings.workspaceId, workspaceId),
        productId
          ? or(
              eq(productSettings.productId, productId),
              isNull(productSettings.productId),
            )
          : isNull(productSettings.productId),
      ),
    );

  const own = productId
    ? rows.find((r) => r.productId === productId)?.mode
    : null;
  const fallback = rows.find((r) => r.productId === null)?.mode;
  const effective = own ?? fallback ?? null;

  if (effective === null) {
    // A workspace with no default row is either invisible to this scope or
    // was created between migration 0064 and this code deploying. Tell those
    // apart by looking at the workspace itself, so a broken scope still fails
    // loudly and a merely un-seeded workspace gets the documented default.
    if (rows.length === 0) {
      const ws = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (ws.length === 0) return null;
    }
    return DEFAULT_TRANSITION_MODE;
  }

  // An unrecognized value (hand-edited row) reads as the safer pipeline
  // rather than silently opening every transition.
  return isTransitionMode(effective) ? effective : "strict";
}
