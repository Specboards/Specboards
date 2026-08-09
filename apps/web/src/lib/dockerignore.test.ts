import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * What must never reach the Docker build context.
 *
 * `infra/web.Dockerfile` does `COPY . .` from the repo root, and `pnpm deploy:*`
 * builds through Fly's REMOTE builder, so everything not excluded is uploaded
 * off the machine. Agent worktrees under `.claude/` were being shipped that way
 * (4000 context files instead of ~740) until a security review noticed.
 *
 * `scripts/deploy.sh` warns about this too, but only on a manual deploy: the
 * push-to-main workflow calls `fly deploy` directly and never runs that script.
 * So the invariant lives here, where CI checks it on every PR.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Directories that hold local agent/editor state and are never build inputs. */
const MUST_BE_IGNORED = [".claude", ".cursor"];

describe(".dockerignore", () => {
  it("excludes local agent state from the build context", async () => {
    const content = await readFile(`${REPO_ROOT}/.dockerignore`, "utf8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    for (const dir of MUST_BE_IGNORED) {
      // Both forms: the bare name matches at the root, `**/` matches nested.
      expect(lines, `${dir} must be in .dockerignore`).toContain(dir);
      expect(lines, `**/${dir} must be in .dockerignore`).toContain(`**/${dir}`);
    }
  });

  it("still excludes the heavy build artifacts", async () => {
    // Guard against a well-meaning tidy-up deleting the rules that keep a
    // locally-built .next (500 MB+) out of the upload.
    const content = await readFile(`${REPO_ROOT}/.dockerignore`, "utf8");
    for (const pattern of ["node_modules", "**/node_modules", ".next", "**/.next"]) {
      expect(content.split("\n").map((l) => l.trim())).toContain(pattern);
    }
  });
});
