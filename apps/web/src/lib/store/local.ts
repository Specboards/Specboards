import { promises as fs } from "node:fs";
import path from "node:path";

import { parseSpec } from "@specboard/core";

import type {
  CustomFieldValue,
  FeatureDetail,
  FeaturePatch,
  FeatureRecord,
  FeatureStore,
  WorkspaceScope,
} from "./types";

interface LocalMetadata {
  status?: string;
  priority?: number | null;
  tags?: string[];
  roadmapQuarter?: string | null;
  assigneeId?: string | null;
  customFields?: Record<string, CustomFieldValue>;
}

type MetadataFile = Record<string, LocalMetadata>;

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
    const [files, meta] = await Promise.all([
      this.walkSpecFiles(this.specsDir),
      this.readMetadata(),
    ]);
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
        status: m.status ?? "backlog",
        priority: m.priority ?? null,
        tags: m.tags ?? [],
        roadmapQuarter: m.roadmapQuarter ?? null,
        assigneeId: m.assigneeId ?? null,
        assigneeName: null, // no user records in local file mode
        customFields: m.customFields ?? {},
        path: path.relative(this.root, file),
        content: parsed.content,
        sections: parsed.sections,
      });
    }
    return features;
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
    const meta = await this.readMetadata();
    meta[specId] = { ...meta[specId], ...patch };
    await this.writeMetadata(meta);
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
