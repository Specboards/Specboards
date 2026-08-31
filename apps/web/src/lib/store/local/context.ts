/**
 * The vocabulary every domain module of the local file store shares.
 *
 * Step 4 of the FeatureStore split does to `local.ts` what step 3 did to the
 * Postgres store: one domain at a time, into plain functions that take the
 * store as `ctx`, with `LocalFileStore` delegating so no caller moves.
 *
 * `LocalStoreContext` is larger than its Postgres counterpart, and the reason
 * is worth stating rather than apologising for. The db store has a query
 * language: a domain that needs an item writes a `select`. This one has files,
 * so "read the items" is a function somebody has to own, and every domain that
 * touches an item needs it. What is here is the file layer plus the four
 * lookups that are genuinely everybody's (the hierarchy, the default product,
 * the terminal status, and the assembled item view), not one domain's helper
 * made public.
 *
 * Nothing here escapes `lib/store/local/`. `store/index.ts` hands callers a
 * `FeatureStore` and this is below that line.
 */

import type { WorkspaceLevel } from "@specboards/core";

import type { FeatureDetail } from "../types";
import type { LocalItem, MetadataFile } from "./types";

/**
 * What a domain module may ask of the store it belongs to.
 *
 * Every member is used by more than one domain. A helper only its own domain
 * calls moves into that domain's module instead, and stays private there.
 */
export interface LocalStoreContext {
  /** The repository root every path is resolved against. See ./paths.ts. */
  readonly root: string;

  /** Read a JSON array file, treating "missing" and "unparseable" as empty. */
  readJsonFile<T>(file: string): Promise<T[]>;
  /** Write a JSON array file, creating `.specboards/` if it is not there. */
  writeJsonFile<T>(file: string, rows: T[]): Promise<void>;

  /** The DB-native items (those with no spec file behind them). */
  readItems(): Promise<LocalItem[]>;
  writeItems(items: LocalItem[]): Promise<void>;

  /** The PM metadata laid over spec-backed items, keyed by spec id. */
  readMetadata(): Promise<MetadataFile>;
  writeMetadata(meta: MetadataFile): Promise<void>;

  /**
   * Every item the workspace has, spec-backed and DB-native alike, with its
   * hierarchy and relations attached. The one read that assembles the whole
   * picture, which is why seven domains start from it.
   */
  loadAll(): Promise<FeatureDetail[]>;

  /** The workspace hierarchy, or null when none has been customised. */
  readLevels(): Promise<WorkspaceLevel[] | null>;
  writeLevels(levels: WorkspaceLevel[]): Promise<void>;

  /** The product work lands in when the caller named none. */
  defaultProductId(): Promise<string>;

  /**
   * The status that counts as finished: the last stage of the workflow in
   * force, not the literal string "done". Cycles, goals and product roll-ups
   * all ask it, and all three were wrong before it existed.
   */
  doneStatusKey(): Promise<string>;
}

/**
 * Whether an item is finished, for every progress figure the store derives
 * (hierarchy roll-up, cycle totals, goal delivery, release progress).
 *
 * `doneKey` is the workflow's terminal stage rather than the literal "done",
 * which is only that workspace's terminal stage by default. See
 * `LocalFileStore.doneStatusKey`.
 */
export function isDone(status: string, doneKey: string): boolean {
  return status === doneKey;
}
