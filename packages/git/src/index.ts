import { randomUUID } from "node:crypto";
import { type ParsedSpec, hasSpecId, parseSpec } from "@specboard/core";

/** A spec file discovered in a repo, with its git pointers. */
export interface SpecFile {
  path: string;
  blobSha: string;
  raw: string;
}

/**
 * Minimal surface the git layer needs from a host (GitHub App, local clone,
 * or a fake in tests). Concrete GitHub implementation lives in `github.ts`.
 */
export interface GitRepoClient {
  /** List spec files matching the repo's configured globs. */
  listSpecFiles(globs: string[]): Promise<SpecFile[]>;
  /** Read a single file's contents + sha at the current ref. */
  readFile(path: string): Promise<SpecFile>;
  /** Write a file back, returning the new commit sha and the new blob sha. */
  writeFile(input: WriteFileInput): Promise<{ commitSha: string; blobSha: string }>;
}

export interface WriteFileInput {
  path: string;
  content: string;
  message: string;
  /** "direct" commits to the branch; "pr" opens a PR from a new branch. */
  mode: "direct" | "pr";
}

/** Outcome of importing/reconciling one spec. */
export interface ReconciledSpec {
  path: string;
  blobSha: string;
  spec: ParsedSpec;
  /** True when an `id` had to be injected (and committed) on first import. */
  idInjected: boolean;
}

/**
 * Import or reconcile specs from a repo: parse each file, inject a stable `id`
 * into any spec that lacks one (writing it back to git), and return structured
 * specs the caller can upsert into `features` + `spec_index`.
 *
 * NOTE: scaffold. The GitHub-backed `GitRepoClient` and webhook signature
 * verification are stubbed in `github.ts` / `webhook.ts` and need wiring.
 */
export async function reconcileSpecs(
  client: GitRepoClient,
  globs: string[],
): Promise<ReconciledSpec[]> {
  const files = await client.listSpecFiles(globs);
  const out: ReconciledSpec[] = [];

  for (const file of files) {
    let { raw, blobSha } = file;
    let idInjected = false;

    if (!hasSpecId(raw)) {
      raw = injectSpecId(raw, randomUUID());
      const written = await client.writeFile({
        path: file.path,
        content: raw,
        message: `chore(specboard): assign stable id to ${file.path}`,
        mode: "direct",
      });
      // Track the new blob sha so a later tree walk sees this file as unchanged.
      blobSha = written.blobSha;
      idInjected = true;
    }

    out.push({ path: file.path, blobSha, spec: parseSpec(raw, file.path), idInjected });
  }

  return out;
}

/** Insert an `id:` line into existing YAML frontmatter (or create a block). */
export function injectSpecId(raw: string, id: string): string {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const head = raw.slice(0, end);
      const rest = raw.slice(end);
      return `${head}\nid: ${id}${rest}`;
    }
  }
  return `---\nid: ${id}\n---\n\n${raw}`;
}

export * from "./github.js";
export * from "./webhook.js";
