import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isLeafLevel,
  isValidParentLevel,
  leafLevel,
  parseSpec,
  resolveLevels,
  resolveLevelUpdate,
  rollUpEstimates,
  type WorkspaceLevel,
} from "@specboard/core";

import {
  FeatureError,
  LevelError,
  RelationError,
  type BoardPreferences,
  type CreateFeatureInput,
  type LevelUpdate,
  type CustomFieldValue,
  type FeatureDetail,
  type FeaturePatch,
  type FeatureRecord,
  type FeatureRelation,
  type FeatureStore,
  type GithubLinkAggregate,
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
  priority: number | null;
  estimate: number | null;
  assigneeId: string | null;
  roadmapQuarter: string | null;
  tags: string[];
  parentSpecId: string | null;
}

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
  priority?: number | null;
  estimate?: number | null;
  rank?: string | null;
  tags?: string[];
  roadmapQuarter?: string | null;
  assigneeId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
  /** Outgoing relations from this spec (see ./types FeatureRelation). */
  links?: LocalLink[];
  /** Parent feature (epic) spec id, or null when top-level. */
  parentSpecId?: string | null;
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
    const [files, meta, items, levels] = await Promise.all([
      this.walkSpecFiles(this.specsDir),
      this.readMetadata(),
      this.readItems(),
      this.readLevels(),
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
        status: m.status ?? "backlog",
        priority: m.priority ?? null,
        estimate: m.estimate ?? null,
        rolledEstimate: null, // filled in by attachHierarchy
        rank: m.rank ?? null,
        tags: m.tags ?? [],
        roadmapQuarter: m.roadmapQuarter ?? null,
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
        status: item.status,
        priority: item.priority,
        estimate: item.estimate,
        rolledEstimate: null, // filled in by attachHierarchy
        rank: null,
        tags: item.tags ?? [],
        roadmapQuarter: item.roadmapQuarter,
        assigneeId: item.assigneeId,
        assigneeName: null,
        customFields: {},
        path: "",
        content: "",
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

  /** Resolve parent titles + direct children + roll-up counts/estimates. */
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
    // Roll estimates up each subtree (parent pointers are now sanitized).
    const rolled = rollUpEstimates(
      features.map((f) => ({
        key: f.specId,
        parentKey: f.parentSpecId,
        estimate: f.estimate,
      })),
    );
    for (const f of features) f.rolledEstimate = rolled.get(f.specId) ?? null;
  }

  /** Resolve stored edges into per-feature relations + blocked counts. */
  private attachRelations(features: FeatureDetail[], meta: MetadataFile): void {
    const titleBySpec = new Map(features.map((f) => [f.specId, f.title]));
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
          });
          if (link.type === "blocks") from.blocksCount += 1;
        }
        if (to && titleBySpec.has(fromSpec)) {
          to.relations.push({
            id: localLinkId(fromSpec, link),
            direction: localDirection(fromSpec, link.type, link.to),
            otherSpecId: fromSpec,
            otherTitle: titleBySpec.get(fromSpec)!,
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
      if (patch.priority !== undefined) it.priority = patch.priority;
      if (patch.estimate !== undefined) it.estimate = patch.estimate;
      if (patch.tags !== undefined) it.tags = patch.tags;
      if (patch.roadmapQuarter !== undefined) it.roadmapQuarter = patch.roadmapQuarter;
      if (patch.assigneeId !== undefined) it.assigneeId = patch.assigneeId;
      if (patch.parentSpecId !== undefined) it.parentSpecId = patch.parentSpecId;
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
    const item: LocalItem = {
      id,
      title,
      level: input.level,
      status: input.status ?? "backlog",
      priority: input.priority ?? null,
      estimate: input.estimate ?? null,
      assigneeId: input.assigneeId ?? null,
      roadmapQuarter: input.roadmapQuarter ?? null,
      tags: input.tags ?? [],
      parentSpecId: input.parentSpecId ?? null,
    };
    const items = await this.readItems();
    await this.writeItems([...items, item]);

    return {
      specId: id,
      title,
      level: item.level,
      isDbNative: true,
      status: item.status,
      priority: item.priority,
      estimate: item.estimate,
      rolledEstimate: item.estimate,
      rank: null,
      tags: item.tags,
      roadmapQuarter: item.roadmapQuarter,
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
        "Spec-backed items can't be deleted here — remove the spec in git.",
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
