import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PRODUCT_KEY,
  isLeafLevel,
  isPropertyType,
  isValidParentLevel,
  leafLevel,
  LOCAL_PRODUCT_ACCESS,
  parseSpec,
  productKeyFromName,
  propertyKeyFromLabel,
  resolveLevels,
  resolveLevelUpdate,
  type PropertyDef,
  type WorkspaceLevel,
} from "@specboard/core";

import {
  compareReleases,
  DetailTemplateError,
  FeatureError,
  LevelError,
  ProductError,
  PropertyError,
  RelationError,
  ReleaseError,
  RELEASE_STATUSES,
  type BoardPreferences,
  type CreateFeatureInput,
  type CreateProductInput,
  type DetailTemplate,
  type DetailTemplateInput,
  type DetailTemplatePatch,
  type LevelUpdate,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type GithubLinkAggregate,
  type ProductAccess,
  type ProductMemberInput,
  type ProductMemberRecord,
  type ProductPatch,
  type ProductRecord,
  type PropertyInput,
  type PropertyPatch,
  type ReleaseInput,
  type ReleasePatch,
  type ReleaseRecord,
  type ResolvedGithubLink,
  type RelationDirection,
  type RelationInput,
  type SavedView,
  type SavedViewInput,
  type WorkspaceScope,
} from "./types";

/** A DB-native work item (initiative/epic) persisted in local file mode. */
interface LocalItem {
  /** Stable id, used as the public specId. */
  id: string;
  title: string;
  level: string;
  status: string;
  assigneeId: string | null;
  tags: string[];
  parentSpecId: string | null;
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
  /** Markdown details body, or null/absent for a blank body. */
  details?: string | null;
}

/** A release persisted in local file mode. */
interface LocalRelease {
  id: string;
  name: string;
  status: "planned" | "in_progress" | "shipped";
  startDate: string | null;
  targetDate: string | null;
}

/** A product (sibling backlog) persisted in local file mode. */
interface LocalProduct {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: "org" | "private";
  position: number;
  color?: string | null;
}

/** The default product seeded when none is persisted (id is stable). */
const LOCAL_DEFAULT_PRODUCT: LocalProduct = {
  id: "default",
  key: DEFAULT_PRODUCT_KEY,
  name: "General",
  description: null,
  visibility: "org",
  position: 0,
  color: null,
};

/** Zero GitHub-link aggregate; file mode has no GitHub connection. */
function emptyGithubSummary(): GithubLinkAggregate {
  return { openPrs: 0, mergedPrs: 0, issues: 0, branches: 0, total: 0 };
}

type LocalLinkType = "blocks" | "relates_to" | "duplicates";

/** A relation stored canonically on the `from` spec's metadata. */
interface LocalLink {
  to: string;
  type: LocalLinkType;
}

interface LocalMetadata {
  status?: string;
  rank?: string | null;
  tags?: string[];
  /** Owning release id, or null when unscheduled. */
  releaseId?: string | null;
  assigneeId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  /** Outgoing relations from this spec (see ./types FeatureRelation). */
  links?: LocalLink[];
  /** Parent feature (epic) spec id, or null when top-level. */
  parentSpecId?: string | null;
  /** Owning product id; defaults to the default product when absent. */
  productId?: string | null;
}

/** The terminal status used for hierarchy roll-up progress. */
function isDone(status: string): boolean {
  return status === "done";
}

type MetadataFile = Record<string, LocalMetadata>;

/** A synthetic, stable id for a local relation (no DB rows to key on). */
function localLinkId(fromSpec: string, link: LocalLink): string {
  return `${fromSpec}:${link.to}:${link.type}`;
}

/** Resolve a stored edge into the direction seen from `viewerSpec`. */
function localDirection(
  fromSpec: string,
  type: LocalLinkType,
  viewerSpec: string,
): RelationDirection {
  const outgoing = fromSpec === viewerSpec;
  switch (type) {
    case "blocks":
      return outgoing ? "blocks" : "blocked_by";
    case "duplicates":
      return outgoing ? "duplicates" : "duplicated_by";
    case "relates_to":
      return "relates_to";
  }
}

/** Map a viewer-relative direction to a canonical stored edge (by specId). */
function toLocalEdge(
  selfSpec: string,
  otherSpec: string,
  direction: RelationInput["direction"],
): { from: string; link: LocalLink } {
  switch (direction) {
    case "blocks":
      return { from: selfSpec, link: { to: otherSpec, type: "blocks" } };
    case "blocked_by":
      return { from: otherSpec, link: { to: selfSpec, type: "blocks" } };
    case "relates_to":
      return { from: selfSpec, link: { to: otherSpec, type: "relates_to" } };
    case "duplicates":
      return { from: selfSpec, link: { to: otherSpec, type: "duplicates" } };
  }
}

/**
 * Zero-setup store for local testing: specs are read straight from the
 * repository's `specs/` directory and PM metadata is persisted to
 * `.specboard/local-metadata.json`. Set `DATABASE_URL` to use Postgres
 * instead (see ./db.ts).
 */
export class LocalFileStore implements FeatureStore {
  constructor(private readonly root: string) {}

  private get specsDir() {
    return path.join(this.root, "specs");
  }

  private get metadataPath() {
    return path.join(this.root, ".specboard", "local-metadata.json");
  }

  private get viewsPath() {
    return path.join(this.root, ".specboard", "local-views.json");
  }

  private get boardPrefsPath() {
    return path.join(this.root, ".specboard", "local-board-prefs.json");
  }

  private get itemsPath() {
    return path.join(this.root, ".specboard", "local-items.json");
  }

  private get levelsPath() {
    return path.join(this.root, ".specboard", "local-levels.json");
  }

  private get productsPath() {
    return path.join(this.root, ".specboard", "local-products.json");
  }

  private get propertiesPath() {
    return path.join(this.root, ".specboard", "local-properties.json");
  }

  private get releasesPath() {
    return path.join(this.root, ".specboard", "local-releases.json");
  }

  private get templatesPath() {
    return path.join(this.root, ".specboard", "local-detail-templates.json");
  }

  /** Persisted products, seeded with the default product when none exist. */
  private async readProducts(): Promise<LocalProduct[]> {
    try {
      const rows = JSON.parse(
        await fs.readFile(this.productsPath, "utf8"),
      ) as LocalProduct[];
      if (rows.length > 0) return rows;
    } catch {
      /* fall through to the seed */
    }
    return [{ ...LOCAL_DEFAULT_PRODUCT }];
  }

  private async writeProducts(rows: LocalProduct[]): Promise<void> {
    await fs.mkdir(path.dirname(this.productsPath), { recursive: true });
    await fs.writeFile(
      this.productsPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  /** The default product id (the seeded "default", or the first product). */
  private async defaultProductId(): Promise<string> {
    const products = await this.readProducts();
    return (
      products.find((p) => p.key === DEFAULT_PRODUCT_KEY)?.id ??
      products[0]?.id ??
      LOCAL_DEFAULT_PRODUCT.id
    );
  }

  /** The configured hierarchy levels, or null when none are persisted. */
  private async readLevels(): Promise<WorkspaceLevel[] | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.levelsPath, "utf8"),
      ) as WorkspaceLevel[];
    } catch {
      return null;
    }
  }

  private async writeLevels(levels: WorkspaceLevel[]): Promise<void> {
    await fs.mkdir(path.dirname(this.levelsPath), { recursive: true });
    await fs.writeFile(
      this.levelsPath,
      JSON.stringify(levels, null, 2) + "\n",
      "utf8",
    );
  }

  /** DB-native work items (initiatives/epics) persisted alongside metadata. */
  private async readItems(): Promise<LocalItem[]> {
    try {
      return JSON.parse(await fs.readFile(this.itemsPath, "utf8")) as LocalItem[];
    } catch {
      return [];
    }
  }

  private async writeItems(items: LocalItem[]): Promise<void> {
    await fs.mkdir(path.dirname(this.itemsPath), { recursive: true });
    await fs.writeFile(
      this.itemsPath,
      JSON.stringify(items, null, 2) + "\n",
      "utf8",
    );
  }

  private async readMetadata(): Promise<MetadataFile> {
    try {
      return JSON.parse(
        await fs.readFile(this.metadataPath, "utf8"),
      ) as MetadataFile;
    } catch {
      return {};
    }
  }

  private async writeMetadata(meta: MetadataFile): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataPath), { recursive: true });
    await fs.writeFile(
      this.metadataPath,
      JSON.stringify(meta, null, 2) + "\n",
      "utf8",
    );
  }

  private async walkSpecFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await this.walkSpecFiles(full)));
      else if (entry.isFile() && entry.name === "spec.md") files.push(full);
    }
    return files;
  }

  private async loadAll(): Promise<FeatureDetail[]> {
    const [files, meta, items, levels, defaultProductId] = await Promise.all([
      this.walkSpecFiles(this.specsDir),
      this.readMetadata(),
      this.readItems(),
      this.readLevels(),
      this.defaultProductId(),
    ]);
    const leafKey = leafLevel(levels).key;
    const features: FeatureDetail[] = [];
    for (const file of files) {
      const raw = await fs.readFile(file, "utf8");
      let parsed;
      try {
        parsed = parseSpec(raw, file);
      } catch {
        continue; // skip malformed specs rather than break the whole board
      }
      const m = meta[parsed.frontmatter.id] ?? {};
      features.push({
        specId: parsed.frontmatter.id,
        title: parsed.frontmatter.title,
        kind: parsed.frontmatter.kind,
        level: leafKey,
        isDbNative: false,
        productId: m.productId ?? defaultProductId,
        status: m.status ?? "backlog",
        rank: m.rank ?? null,
        tags: m.tags ?? [],
        releaseId: m.releaseId ?? null,
        assigneeId: m.assigneeId ?? null,
        assigneeName: null, // no user records in local file mode
        customFields: m.customFields ?? {},
        path: path.relative(this.root, file),
        content: parsed.content,
        sections: parsed.sections,
        relations: [],
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: m.parentSpecId ?? null,
        parentTitle: null,
        children: [],
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyGithubSummary(),
        githubLinks: [],
      });
    }
    // DB-native items (initiatives/epics) — no spec/content; merged into the
    // same set so hierarchy roll-ups span all levels.
    for (const item of items) {
      features.push({
        specId: item.id,
        title: item.title,
        level: item.level,
        isDbNative: true,
        productId: item.productId ?? defaultProductId,
        status: item.status,
        rank: null,
        tags: item.tags ?? [],
        releaseId: item.releaseId ?? null,
        assigneeId: item.assigneeId,
        assigneeName: null,
        customFields: {},
        path: "",
        content: item.details ?? "",
        sections: [],
        relations: [],
        blocksCount: 0,
        blockedByCount: 0,
        parentSpecId: item.parentSpecId ?? null,
        parentTitle: null,
        children: [],
        childCount: 0,
        childDoneCount: 0,
        githubSummary: emptyGithubSummary(),
        githubLinks: [],
      });
    }
    this.attachRelations(features, meta);
    this.attachHierarchy(features);
    return features;
  }

  /** Resolve parent titles + direct children + roll-up counts. */
  private attachHierarchy(features: FeatureDetail[]): void {
    const bySpec = new Map(features.map((f) => [f.specId, f]));
    for (const f of features) {
      // Drop a parent pointer to a spec that no longer exists.
      const parent = f.parentSpecId ? bySpec.get(f.parentSpecId) : undefined;
      if (!parent) {
        f.parentSpecId = null;
        continue;
      }
      f.parentTitle = parent.title;
      parent.children.push({ specId: f.specId, title: f.title, status: f.status });
      parent.childCount += 1;
      if (isDone(f.status)) parent.childDoneCount += 1;
    }
  }

  /** Resolve stored edges into per-feature relations + blocked counts. */
  private attachRelations(features: FeatureDetail[], meta: MetadataFile): void {
    const titleBySpec = new Map(features.map((f) => [f.specId, f.title]));
    const levelBySpec = new Map(features.map((f) => [f.specId, f.level]));
    const bySpec = new Map(features.map((f) => [f.specId, f]));
    for (const [fromSpec, m] of Object.entries(meta)) {
      for (const link of m.links ?? []) {
        const from = bySpec.get(fromSpec);
        const to = bySpec.get(link.to);
        if (from && titleBySpec.has(link.to)) {
          from.relations.push({
            id: localLinkId(fromSpec, link),
            direction: localDirection(fromSpec, link.type, fromSpec),
            otherSpecId: link.to,
            otherTitle: titleBySpec.get(link.to)!,
            otherLevel: levelBySpec.get(link.to)!,
          });
          if (link.type === "blocks") from.blocksCount += 1;
        }
        if (to && titleBySpec.has(fromSpec)) {
          to.relations.push({
            id: localLinkId(fromSpec, link),
            direction: localDirection(fromSpec, link.type, link.to),
            otherSpecId: fromSpec,
            otherTitle: titleBySpec.get(fromSpec)!,
            otherLevel: levelBySpec.get(fromSpec)!,
          });
          if (link.type === "blocks") to.blockedByCount += 1;
        }
      }
    }
  }

  // The local store has a single implicit workspace, so `scope` is ignored.
  async listFeatures(_scope?: WorkspaceScope): Promise<FeatureRecord[]> {
    return this.loadAll();
  }

  async getFeature(
    specId: string,
    _scope?: WorkspaceScope,
  ): Promise<FeatureDetail | null> {
    const all = await this.loadAll();
    return all.find((f) => f.specId === specId) ?? null;
  }

  async updateFeature(
    specId: string,
    patch: FeaturePatch,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // DB-native items live in their own file, not the spec-metadata map.
    const items = await this.readItems();
    const idx = items.findIndex((i) => i.id === specId);
    if (idx >= 0) {
      const it = items[idx]!;
      if (patch.title !== undefined) it.title = patch.title;
      if (patch.status !== undefined) it.status = patch.status;
      if (patch.tags !== undefined) it.tags = patch.tags;
      if (patch.releaseId !== undefined) it.releaseId = patch.releaseId;
      if (patch.assigneeId !== undefined) it.assigneeId = patch.assigneeId;
      if (patch.parentSpecId !== undefined) it.parentSpecId = patch.parentSpecId;
      if (patch.details !== undefined)
        it.details = patch.details?.trim() ? patch.details : null;
      await this.writeItems(items);
      return;
    }
    const meta = await this.readMetadata();
    meta[specId] = { ...meta[specId], ...patch };
    await this.writeMetadata(meta);
  }

  async listLevels(_scope?: WorkspaceScope): Promise<WorkspaceLevel[]> {
    // Persisted config if present, else the default hierarchy.
    return resolveLevels(await this.readLevels());
  }

  async updateLevels(
    updates: LevelUpdate[],
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    let resolved;
    try {
      resolved = resolveLevelUpdate(current, updates);
    } catch (err) {
      throw new LevelError(err instanceof Error ? err.message : "Invalid levels.");
    }
    if (resolved.removedKeys.length > 0) {
      const items = await this.readItems();
      const used = items.find((i) => resolved.removedKeys.includes(i.level));
      if (used) {
        throw new LevelError(
          `Can't remove the "${used.level}" level while items still use it.`,
        );
      }
    }
    await this.writeLevels(resolved.levels);
    return resolved.levels;
  }

  async updateLevelFields(
    fields: Record<string, string[] | null>,
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    const known = new Set(current.map((l) => l.key));
    for (const key of Object.keys(fields)) {
      if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    const updated = current.map((l) =>
      Object.prototype.hasOwnProperty.call(fields, l.key)
        ? { ...l, fields: fields[l.key] ?? null }
        : l,
    );
    await this.writeLevels(updated);
    return updated;
  }

  async createFeature(
    input: CreateFeatureInput,
    _scope?: WorkspaceScope,
  ): Promise<FeatureRecord> {
    const levels = resolveLevels();
    const title = input.title.trim();
    if (!title) throw new FeatureError("Title is required.");
    if (!levels.some((l) => l.key === input.level))
      throw new FeatureError(`Unknown level: ${input.level}`);
    if (isLeafLevel(input.level, levels))
      throw new FeatureError(
        "Leaf-level items come from specs and can't be created here.",
      );

    if (input.parentSpecId) {
      const all = await this.loadAll();
      const parent = all.find((f) => f.specId === input.parentSpecId);
      if (!parent) throw new FeatureError(`Unknown parent: ${input.parentSpecId}`);
      if (!isValidParentLevel(input.level, parent.level, levels))
        throw new FeatureError(
          `A ${input.level} can't sit under a ${parent.level}.`,
        );
    } else if (!isValidParentLevel(input.level, null, levels)) {
      throw new FeatureError(`A ${input.level} requires a parent.`);
    }

    const id = randomUUID();
    const productId = input.productId ?? (await this.defaultProductId());
    const item: LocalItem = {
      id,
      title,
      level: input.level,
      status: input.status ?? "backlog",
      assigneeId: input.assigneeId ?? null,
      tags: input.tags ?? [],
      parentSpecId: input.parentSpecId ?? null,
      releaseId: null,
      productId,
      details: input.details?.trim() ? input.details : null,
    };
    const items = await this.readItems();
    await this.writeItems([...items, item]);

    return {
      specId: id,
      title,
      level: item.level,
      isDbNative: true,
      productId,
      status: item.status,
      rank: null,
      tags: item.tags,
      releaseId: null,
      assigneeId: item.assigneeId,
      customFields: {},
      path: "",
      blocksCount: 0,
      blockedByCount: 0,
      parentSpecId: item.parentSpecId,
      childCount: 0,
      childDoneCount: 0,
      githubSummary: emptyGithubSummary(),
    } satisfies FeatureRecord;
  }

  async deleteFeature(specId: string, _scope?: WorkspaceScope): Promise<void> {
    const items = await this.readItems();
    if (!items.some((i) => i.id === specId))
      throw new FeatureError(
        "Spec-backed items can't be deleted here. Remove the spec in git.",
      );
    await this.writeItems(items.filter((i) => i.id !== specId));
  }

  async addRelation(
    specId: string,
    input: RelationInput,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    if (specId === input.toSpecId)
      throw new RelationError("A feature cannot relate to itself.");
    const all = await this.loadAll();
    const known = new Set(all.map((f) => f.specId));
    if (!known.has(specId)) throw new RelationError(`Unknown feature: ${specId}`);
    if (!known.has(input.toSpecId))
      throw new RelationError(`Unknown related feature: ${input.toSpecId}`);

    const { from, link } = toLocalEdge(specId, input.toSpecId, input.direction);
    const meta = await this.readMetadata();

    // Reject a contradictory cycle (A blocks B while B blocks A).
    if (link.type === "blocks") {
      const reverse = (meta[link.to]?.links ?? []).some(
        (l) => l.type === "blocks" && l.to === from,
      );
      if (reverse)
        throw new RelationError(
          "That would create a circular blocking dependency.",
        );
    }

    const existing = meta[from]?.links ?? [];
    // Symmetric relates_to: skip if the inverse edge already exists.
    const inverseExists =
      link.type === "relates_to" &&
      (meta[link.to]?.links ?? []).some(
        (l) => l.type === "relates_to" && l.to === from,
      );
    const duplicate = existing.some(
      (l) => l.to === link.to && l.type === link.type,
    );
    if (!duplicate && !inverseExists) {
      meta[from] = { ...meta[from], links: [...existing, link] };
      await this.writeMetadata(meta);
    }
  }

  async removeRelation(
    _specId: string,
    linkId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // linkId is `${fromSpec}:${toSpec}:${type}` (see localLinkId).
    const [fromSpec, toSpec, type] = linkId.split(":");
    if (!fromSpec || !toSpec || !type) return;
    const meta = await this.readMetadata();
    const links = meta[fromSpec]?.links;
    if (!links) return;
    meta[fromSpec] = {
      ...meta[fromSpec],
      links: links.filter((l) => !(l.to === toSpec && l.type === type)),
    };
    await this.writeMetadata(meta);
  }

  // GitHub linking requires a connected GitHub App, which file mode doesn't
  // have. Reads return nothing (see loadAll); writes are rejected clearly.
  async addGithubLink(
    _specId: string,
    _link: ResolvedGithubLink,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    throw new RelationError(
      "GitHub linking requires a connected repository (not available in local file mode).",
    );
  }

  async removeGithubLink(
    _specId: string,
    _linkId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // Nothing to remove in file mode.
  }

  // Saved views persist to `.specboard/local-views.json`. There's a single
  // implicit user in local mode, so no per-user scoping.
  private async readViews(): Promise<SavedView[]> {
    try {
      return JSON.parse(await fs.readFile(this.viewsPath, "utf8")) as SavedView[];
    } catch {
      return [];
    }
  }

  private async writeViews(views: SavedView[]): Promise<void> {
    await fs.mkdir(path.dirname(this.viewsPath), { recursive: true });
    await fs.writeFile(
      this.viewsPath,
      JSON.stringify(views, null, 2) + "\n",
      "utf8",
    );
  }

  async listSavedViews(_scope?: WorkspaceScope): Promise<SavedView[]> {
    return this.readViews();
  }

  async createSavedView(
    input: SavedViewInput,
    _scope?: WorkspaceScope,
  ): Promise<SavedView> {
    const views = await this.readViews();
    const view: SavedView = {
      id: randomUUID(),
      name: input.name,
      view: input.view,
      filters: input.filters,
    };
    await this.writeViews([view, ...views]); // newest first, matching db order
    return view;
  }

  async deleteSavedView(id: string, _scope?: WorkspaceScope): Promise<void> {
    const views = await this.readViews();
    await this.writeViews(views.filter((v) => v.id !== id));
  }

  // Board preferences persist to `.specboard/local-board-prefs.json`. Single
  // implicit user in local mode, so no per-user scoping.
  async getBoardPreferences(
    _scope?: WorkspaceScope,
  ): Promise<BoardPreferences | null> {
    try {
      return JSON.parse(
        await fs.readFile(this.boardPrefsPath, "utf8"),
      ) as BoardPreferences;
    } catch {
      return null;
    }
  }

  async setBoardPreferences(
    prefs: BoardPreferences,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.boardPrefsPath), { recursive: true });
    await fs.writeFile(
      this.boardPrefsPath,
      JSON.stringify(prefs, null, 2) + "\n",
      "utf8",
    );
  }

  // Custom properties persist to `.specboard/local-properties.json`.
  private async readProperties(): Promise<PropertyDef[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.propertiesPath, "utf8"),
      ) as PropertyDef[];
    } catch {
      return [];
    }
  }

  private async writeProperties(rows: PropertyDef[]): Promise<void> {
    await fs.mkdir(path.dirname(this.propertiesPath), { recursive: true });
    await fs.writeFile(
      this.propertiesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  async listProperties(_scope?: WorkspaceScope): Promise<PropertyDef[]> {
    const rows = await this.readProperties();
    return rows.sort((a, b) => a.position - b.position);
  }

  async createProperty(
    input: PropertyInput,
    _scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    const label = input.label.trim();
    if (!label) throw new PropertyError("Property label is required.");
    if (!isPropertyType(input.type)) {
      throw new PropertyError(`Unknown property type: ${String(input.type)}`);
    }
    const rows = await this.readProperties();
    const property: PropertyDef = {
      id: randomUUID(),
      key: propertyKeyFromLabel(label, new Set(rows.map((p) => p.key))),
      label,
      type: input.type,
      options: localNormalizeOptions(input.type, input.options),
      levels: input.levels ?? null,
      position: rows.reduce((m, p) => Math.max(m, p.position), -1) + 1,
    };
    await this.writeProperties([...rows, property]);
    return property;
  }

  async updateProperty(
    id: string,
    patch: PropertyPatch,
    _scope?: WorkspaceScope,
  ): Promise<PropertyDef> {
    const rows = await this.readProperties();
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
    await this.writeProperties(rows);
    return property;
  }

  async deleteProperty(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readProperties();
    if (!rows.some((p) => p.id === id))
      throw new PropertyError(`Unknown property: ${id}`);
    await this.writeProperties(rows.filter((p) => p.id !== id));
  }

  // Detail templates persist to `.specboard/local-detail-templates.json`.
  private async readTemplates(): Promise<DetailTemplate[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.templatesPath, "utf8"),
      ) as DetailTemplate[];
    } catch {
      return [];
    }
  }

  private async writeTemplates(rows: DetailTemplate[]): Promise<void> {
    await fs.mkdir(path.dirname(this.templatesPath), { recursive: true });
    await fs.writeFile(
      this.templatesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  async listDetailTemplates(
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate[]> {
    const rows = await this.readTemplates();
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async createDetailTemplate(
    input: DetailTemplateInput,
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    const name = input.name.trim();
    if (!name) throw new DetailTemplateError("Template name is required.");
    const rows = await this.readTemplates();
    if (rows.some((t) => t.name === name))
      throw new DetailTemplateError(`A template named "${name}" already exists.`);
    const template: DetailTemplate = {
      id: randomUUID(),
      name,
      body: input.body ?? "",
    };
    await this.writeTemplates([...rows, template]);
    return template;
  }

  async updateDetailTemplate(
    id: string,
    patch: DetailTemplatePatch,
    _scope?: WorkspaceScope,
  ): Promise<DetailTemplate> {
    const rows = await this.readTemplates();
    const template = rows.find((t) => t.id === id);
    if (!template) throw new DetailTemplateError(`Unknown template: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new DetailTemplateError("Template name is required.");
      if (rows.some((t) => t.id !== id && t.name === name))
        throw new DetailTemplateError(`A template named "${name}" already exists.`);
      template.name = name;
    }
    if (patch.body !== undefined) template.body = patch.body;
    await this.writeTemplates(rows);
    return template;
  }

  async deleteDetailTemplate(
    id: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    const rows = await this.readTemplates();
    if (!rows.some((t) => t.id === id))
      throw new DetailTemplateError(`Unknown template: ${id}`);
    await this.writeTemplates(rows.filter((t) => t.id !== id));
    // Clear the pointer from any level that referenced it.
    const levels = resolveLevels(await this.readLevels());
    if (levels.some((l) => l.detailTemplateId === id)) {
      await this.writeLevels(
        levels.map((l) =>
          l.detailTemplateId === id ? { ...l, detailTemplateId: null } : l,
        ),
      );
    }
  }

  async updateLevelTemplates(
    templates: Record<string, string | null>,
    _scope?: WorkspaceScope,
  ): Promise<WorkspaceLevel[]> {
    const current = resolveLevels(await this.readLevels());
    const known = new Set(current.map((l) => l.key));
    for (const key of Object.keys(templates)) {
      if (!known.has(key)) throw new LevelError(`Unknown level: ${key}`);
    }
    const templateIds = new Set((await this.readTemplates()).map((t) => t.id));
    for (const value of Object.values(templates)) {
      if (value && !templateIds.has(value))
        throw new LevelError(`Unknown detail template: ${value}`);
    }
    const updated = current.map((l) =>
      Object.prototype.hasOwnProperty.call(templates, l.key)
        ? { ...l, detailTemplateId: templates[l.key] ?? null }
        : l,
    );
    await this.writeLevels(updated);
    return updated;
  }

  // Releases persist to `.specboard/local-releases.json`.
  private async readReleases(): Promise<LocalRelease[]> {
    try {
      return JSON.parse(
        await fs.readFile(this.releasesPath, "utf8"),
      ) as LocalRelease[];
    } catch {
      return [];
    }
  }

  private async writeReleases(rows: LocalRelease[]): Promise<void> {
    await fs.mkdir(path.dirname(this.releasesPath), { recursive: true });
    await fs.writeFile(
      this.releasesPath,
      JSON.stringify(rows, null, 2) + "\n",
      "utf8",
    );
  }

  async listReleases(_scope?: WorkspaceScope): Promise<ReleaseRecord[]> {
    const [rows, all] = await Promise.all([this.readReleases(), this.loadAll()]);
    const counts = new Map<string, number>();
    for (const f of all) {
      if (f.releaseId) counts.set(f.releaseId, (counts.get(f.releaseId) ?? 0) + 1);
    }
    return rows
      .map((r) => ({ ...r, itemCount: counts.get(r.id) ?? 0 }))
      .sort(compareReleases);
  }

  async createRelease(
    input: ReleaseInput,
    _scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    const name = input.name.trim();
    if (!name) throw new ReleaseError("Release name is required.");
    const rows = await this.readReleases();
    if (rows.some((r) => r.name === name)) {
      throw new ReleaseError(`A release named "${name}" already exists.`);
    }
    const status = input.status ?? "planned";
    if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
      throw new ReleaseError(`Unknown release status: ${status}`);
    }
    const release: LocalRelease = {
      id: randomUUID(),
      name,
      status,
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
    };
    await this.writeReleases([...rows, release]);
    return { ...release, itemCount: 0 };
  }

  async updateRelease(
    id: string,
    patch: ReleasePatch,
    _scope?: WorkspaceScope,
  ): Promise<ReleaseRecord> {
    const rows = await this.readReleases();
    const release = rows.find((r) => r.id === id);
    if (!release) throw new ReleaseError(`Unknown release: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ReleaseError("Release name is required.");
      release.name = name;
    }
    if (patch.status !== undefined) {
      if (!(RELEASE_STATUSES as readonly string[]).includes(patch.status)) {
        throw new ReleaseError(`Unknown release status: ${patch.status}`);
      }
      release.status = patch.status;
    }
    if (patch.startDate !== undefined) release.startDate = patch.startDate;
    if (patch.targetDate !== undefined) release.targetDate = patch.targetDate;
    await this.writeReleases(rows);
    const all = await this.loadAll();
    return {
      ...release,
      itemCount: all.filter((f) => f.releaseId === id).length,
    };
  }

  async deleteRelease(id: string, _scope?: WorkspaceScope): Promise<void> {
    const rows = await this.readReleases();
    if (!rows.some((r) => r.id === id))
      throw new ReleaseError(`Unknown release: ${id}`);
    await this.writeReleases(rows.filter((r) => r.id !== id));
    // Unschedule the deleted release's items (mirrors the DB's SET NULL).
    const items = await this.readItems();
    let itemsChanged = false;
    for (const item of items) {
      if (item.releaseId === id) {
        item.releaseId = null;
        itemsChanged = true;
      }
    }
    if (itemsChanged) await this.writeItems(items);
    const meta = await this.readMetadata();
    let metaChanged = false;
    for (const m of Object.values(meta)) {
      if (m.releaseId === id) {
        m.releaseId = null;
        metaChanged = true;
      }
    }
    if (metaChanged) await this.writeMetadata(meta);
  }

  // Products. Local file mode is a single all-powerful user (see core
  // LOCAL_PRODUCT_ACCESS), so visibility/permissions aren't enforced; products
  // persist to `.specboard/local-products.json` for switcher parity.
  async getProductAccess(_scope?: WorkspaceScope): Promise<ProductAccess> {
    return LOCAL_PRODUCT_ACCESS;
  }

  /** Item counts per product, derived from all features (specs + items). */
  private async productItemCounts(): Promise<Map<string, number>> {
    const features = await this.loadAll();
    const out = new Map<string, number>();
    for (const f of features) {
      if (f.productId) out.set(f.productId, (out.get(f.productId) ?? 0) + 1);
    }
    return out;
  }

  private toProductRecord(
    p: LocalProduct,
    counts: Map<string, number>,
  ): ProductRecord {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      visibility: p.visibility,
      position: p.position,
      color: p.color ?? null,
      itemCount: counts.get(p.id) ?? 0,
      viewerRole: null,
    };
  }

  async listProducts(_scope?: WorkspaceScope): Promise<ProductRecord[]> {
    const [products, counts] = await Promise.all([
      this.readProducts(),
      this.productItemCounts(),
    ]);
    return products
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((p) => this.toProductRecord(p, counts));
  }

  async getProduct(
    key: string,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord | null> {
    const products = await this.readProducts();
    const p = products.find((x) => x.key === key);
    if (!p) return null;
    return this.toProductRecord(p, await this.productItemCounts());
  }

  async createProduct(
    input: CreateProductInput,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    const name = input.name.trim();
    if (!name) throw new ProductError("Product name is required.");
    const products = await this.readProducts();
    const key = productKeyFromName(name, new Set(products.map((p) => p.key)));
    const product: LocalProduct = {
      id: randomUUID(),
      key,
      name,
      description: input.description ?? null,
      visibility: input.visibility ?? "org",
      color: input.color ?? null,
      position: products.reduce((m, p) => Math.max(m, p.position), -1) + 1,
    };
    await this.writeProducts([...products, product]);
    return this.toProductRecord(product, new Map());
  }

  async updateProduct(
    id: string,
    patch: ProductPatch,
    _scope?: WorkspaceScope,
  ): Promise<ProductRecord> {
    const products = await this.readProducts();
    const p = products.find((x) => x.id === id);
    if (!p) throw new ProductError(`Unknown product: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProductError("Product name is required.");
      p.name = name;
    }
    if (patch.description !== undefined) p.description = patch.description;
    if (patch.visibility !== undefined) p.visibility = patch.visibility;
    if (patch.position !== undefined) p.position = patch.position;
    if (patch.color !== undefined) p.color = patch.color;
    await this.writeProducts(products);
    return this.toProductRecord(p, await this.productItemCounts());
  }

  async deleteProduct(id: string, _scope?: WorkspaceScope): Promise<void> {
    const counts = await this.productItemCounts();
    if ((counts.get(id) ?? 0) > 0) {
      throw new ProductError(
        "Can't delete a product while it still has work items.",
      );
    }
    const products = await this.readProducts();
    if (!products.some((p) => p.id === id))
      throw new ProductError(`Unknown product: ${id}`);
    await this.writeProducts(products.filter((p) => p.id !== id));
  }

  // Membership needs real user records, which file mode doesn't have.
  async listProductMembers(
    _productId: string,
    _scope?: WorkspaceScope,
  ): Promise<ProductMemberRecord[]> {
    return [];
  }

  async setProductMember(
    _productId: string,
    _input: ProductMemberInput,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    throw new ProductError(
      "Managing product members requires authentication (not available in local file mode).",
    );
  }

  async removeProductMember(
    _productId: string,
    _userId: string,
    _scope?: WorkspaceScope,
  ): Promise<void> {
    // Nothing to remove in file mode.
  }
}

/** Options only make sense for select/multiselect; other types store none. */
function localNormalizeOptions(
  type: PropertyDef["type"],
  options: string[] | undefined,
): string[] {
  if (type !== "select" && type !== "multiselect") return [];
  return [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))];
}

/** Walk upward from cwd to find the repo root (the dir holding `specs/`). */
export async function findRepoRoot(start = process.cwd()): Promise<string> {
  if (process.env.SPECBOARD_ROOT) return process.env.SPECBOARD_ROOT;
  let dir = start;
  for (;;) {
    try {
      const stat = await fs.stat(path.join(dir, "specs"));
      if (stat.isDirectory()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
