import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocPageRecord, DocSpace } from "@/lib/store/types";

import type { McpContext } from "./types";

/**
 * The doc-area tools (Strategy / Research / Architecture). What is worth
 * covering here is the adapter logic that has nowhere else to live: resolving
 * a product key, dispatching on how the area is backed, refusing to write to
 * an area that only links out, adopting a source so a created page is actually
 * visible, and the guard that stops a folder delete from silently taking a
 * subtree with it. The store and the GitHub client are faked; their own
 * behaviour is covered by their own tests.
 */

const PRODUCTS = [
  { id: "prod-1", key: "atlas", name: "Atlas" },
  { id: "prod-2", key: "beacon", name: "Beacon" },
];

let space: DocSpace;
let pages: DocPageRecord[];
/** Product ids the caller may write; empty means read-only. */
let writable: string[];

const store = {
  listProducts: vi.fn(async () => PRODUCTS),
  getDocSpace: vi.fn(async () => space),
  setDocSpace: vi.fn(async (productId: string, area: string, input: { mode: string }) => {
    space = { ...space, mode: input.mode as DocSpace["mode"] };
    return space;
  }),
  listDocPages: vi.fn(async () => pages),
  createDocPage: vi.fn(async (input: Record<string, unknown>) => {
    const page: DocPageRecord = {
      id: `page-${pages.length + 1}`,
      productId: input.productId as string,
      area: input.area as DocPageRecord["area"],
      parentId: (input.parentId as string | null) ?? null,
      kind: (input.kind as "page" | "folder") ?? "page",
      title: input.title as string,
      content: (input.content as string) ?? "",
      position: pages.length,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    pages.push(page);
    return page;
  }),
  updateDocPage: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const page = pages.find((p) => p.id === id);
    if (!page) throw new Error(`unknown page ${id}`);
    Object.assign(page, patch);
    return page;
  }),
  deleteDocPage: vi.fn(async (id: string) => {
    pages = pages.filter((p) => p.id !== id);
  }),
  getProductAccess: vi.fn(async () => ({
    isOrgAdmin: false,
    roles: new Map(writable.map((id) => [id, "contributor" as const])),
  })),
};

const github = {
  loadGithubDocs: vi.fn(async () => ({
    repo: {
      id: "repo-1",
      owner: "acme",
      name: "docs",
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme/docs",
    },
    files: [
      { path: "constitution.md", content: "# Rules", blobSha: "sha-a" },
      { path: "services/api.md", content: "# API", blobSha: "sha-b" },
    ],
  })),
  readGithubDocFile: vi.fn(async (_db, _ws, _space, path: string) => ({
    path,
    content: `# ${path}`,
    blobSha: "sha-current",
  })),
  saveGithubDocFile: vi.fn(async () => ({
    commitSha: "commit-1",
    blobSha: "sha-new",
  })),
  deleteGithubDocFile: vi.fn(async () => ({ commitSha: "commit-2" })),
  renameGithubDocFile: vi.fn(async () => ({
    blobSha: "sha-renamed",
    content: "# moved",
  })),
};

vi.mock("@/lib/store", () => ({ getStore: async () => store }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ fake: true }) }));
vi.mock("@/lib/github-docs", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/github-docs")>(
      "@/lib/github-docs",
    );
  return { ...actual, ...github };
});

const { DOC_TOOLS } = await import("./doc-tools");

const tool = (name: string) => {
  const found = DOC_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const ctx: McpContext = {
  scope: { userId: "user-1", workspaceId: "ws-1" },
  role: "member",
  isLocal: false,
  // Unrestricted: these tests exercise the tools, not the scope gate (which
  // lives in rpc.ts and is covered by rpc.test.ts).
  scopes: [],
  // Likewise no quota: the rate limit is applied by the RPC layer, not here.
  credentialKey: null,
  allowDestructive: true,
};

function page(over: Partial<DocPageRecord> & { id: string }): DocPageRecord {
  return {
    productId: "prod-1",
    area: "research",
    parentId: null,
    kind: "page",
    title: "Untitled",
    content: "",
    position: 0,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  space = {
    productId: "prod-1",
    area: "research",
    mode: "local",
    externalUrl: null,
    repoId: null,
  };
  pages = [];
  writable = ["prod-1", "prod-2"];
  vi.clearAllMocks();
});

describe("addressing", () => {
  it("names the bad key when the product does not exist", async () => {
    await expect(
      tool("list_docs").run({ product: "nope", area: "research" }, ctx),
    ).rejects.toThrow(/No product with key "nope"/);
  });

  it("rejects an area that is not a doc area", async () => {
    await expect(
      tool("list_docs").run({ product: "atlas", area: "backlog" }, ctx),
    ).rejects.toThrow(/Unknown doc area/);
  });
});

describe("list_docs", () => {
  it("returns pages without their bodies, and the area's source", async () => {
    pages = [
      page({ id: "p1", title: "Interviews", content: "a".repeat(120) }),
      page({ id: "p2", title: "Synthesis", parentId: "p1", content: "" }),
    ];
    const out = (await tool("list_docs").run(
      { product: "atlas", area: "research" },
      ctx,
    )) as { source: { mode: string }; pages: Record<string, unknown>[] };

    expect(out.source.mode).toBe("local");
    expect(out.pages).toEqual([
      {
        docId: "p1",
        kind: "page",
        title: "Interviews",
        parentId: null,
        contentChars: 120,
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
      {
        docId: "p2",
        kind: "page",
        title: "Synthesis",
        parentId: "p1",
        contentChars: 0,
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ]);
  });

  it("lists a GitHub-backed area's files, keyed by repo path", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    const out = (await tool("list_docs").run(
      { product: "atlas", area: "architecture" },
      ctx,
    )) as { repo: { fullName: string }; pages: Record<string, unknown>[] };

    expect(out.repo.fullName).toBe("acme/docs");
    expect(out.pages.map((p) => p.docId)).toEqual([
      "constitution.md",
      "services/api.md",
    ]);
    expect(out.pages[1]).toMatchObject({ title: "api", folder: "services" });
  });

  it("returns the link and no pages when the area points outside", async () => {
    space = {
      ...space,
      mode: "external",
      externalUrl: "https://example.sharepoint.com/research",
    };
    const out = (await tool("list_docs").run(
      { product: "atlas", area: "research" },
      ctx,
    )) as { source: { externalUrl: string }; pages: unknown[] };

    expect(out.pages).toEqual([]);
    expect(out.source.externalUrl).toBe(
      "https://example.sharepoint.com/research",
    );
  });
});

describe("read_doc", () => {
  it("returns the Markdown body", async () => {
    pages = [page({ id: "p1", title: "Interviews", content: "# Notes" })];
    const out = (await tool("read_doc").run(
      { product: "atlas", area: "research", docId: "p1" },
      ctx,
    )) as { content: string; title: string };
    expect(out).toMatchObject({ title: "Interviews", content: "# Notes" });
  });

  it("says which area an unknown id was not found in", async () => {
    await expect(
      tool("read_doc").run(
        { product: "atlas", area: "research", docId: "p9" },
        ctx,
      ),
    ).rejects.toThrow(/No page with id p9 in the research area for "atlas"/);
  });

  it("reads one GitHub file rather than the whole repo", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    const out = (await tool("read_doc").run(
      { product: "atlas", area: "architecture", docId: "services/api.md" },
      ctx,
    )) as { docId: string; content: string };

    expect(github.loadGithubDocs).not.toHaveBeenCalled();
    expect(github.readGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "services/api.md",
    );
    expect(out.docId).toBe("services/api.md");
  });
});

describe("create_doc", () => {
  it("adopts Specboards-held pages when no source was chosen yet", async () => {
    space = { ...space, mode: "unset" };
    const out = (await tool("create_doc").run(
      { product: "atlas", area: "research", title: "Interviews" },
      ctx,
    )) as { sourceInitialized: boolean; docId: string };

    expect(store.setDocSpace).toHaveBeenCalledWith(
      "prod-1",
      "research",
      { mode: "local" },
      ctx.scope,
    );
    expect(out.sourceInitialized).toBe(true);
    expect(out.docId).toBe("page-1");
  });

  it("leaves an already-chosen source alone", async () => {
    await tool("create_doc").run(
      { product: "atlas", area: "research", title: "Interviews" },
      ctx,
    );
    expect(store.setDocSpace).not.toHaveBeenCalled();
  });

  it("stores the Markdown body and the parent folder", async () => {
    await tool("create_doc").run(
      {
        product: "atlas",
        area: "research",
        title: "Synthesis",
        parentId: "folder-1",
        content: "# Findings",
      },
      ctx,
    );
    expect(store.createDocPage).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod-1",
        area: "research",
        title: "Synthesis",
        kind: "page",
        parentId: "folder-1",
        content: "# Findings",
      }),
      ctx.scope,
    );
  });

  it("refuses to write into an area that only links out", async () => {
    space = { ...space, mode: "external", externalUrl: "https://example.com" };
    await expect(
      tool("create_doc").run(
        { product: "atlas", area: "research", title: "Interviews" },
        ctx,
      ),
    ).rejects.toThrow(/links out to https:\/\/example.com/);
    expect(store.createDocPage).not.toHaveBeenCalled();
  });

  it("derives a repo path from the title and commits it create-guarded", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    const out = (await tool("create_doc").run(
      {
        product: "atlas",
        area: "architecture",
        title: "Service architecture",
        content: "# Boundaries",
      },
      ctx,
    )) as { docId: string };

    expect(out.docId).toBe("service-architecture.md");
    expect(github.saveGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "service-architecture.md",
      "# Boundaries",
      null,
    );
  });

  it("takes an explicit repo path over the title", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    const out = (await tool("create_doc").run(
      {
        product: "atlas",
        area: "architecture",
        title: "Contracts",
        path: "services/contracts.md",
      },
      ctx,
    )) as { docId: string; folder: string };
    expect(out).toMatchObject({
      docId: "services/contracts.md",
      folder: "services",
    });
  });

  it("rejects a path that escapes the docs tree", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    await expect(
      tool("create_doc").run(
        {
          product: "atlas",
          area: "architecture",
          title: "Sneaky",
          path: "../../.github/workflows/deploy.md",
        },
        ctx,
      ),
    ).rejects.toThrow(/unsupported characters/);
    expect(github.saveGithubDocFile).not.toHaveBeenCalled();
  });

  it("refuses a GitHub commit from a caller without product write", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    writable = ["prod-2"];
    await expect(
      tool("create_doc").run(
        { product: "atlas", area: "architecture", title: "Contracts" },
        ctx,
      ),
    ).rejects.toThrow(/does not permit editing these docs/);
    expect(github.saveGithubDocFile).not.toHaveBeenCalled();
  });
});

describe("update_doc", () => {
  it("applies only the fields that were passed", async () => {
    pages = [page({ id: "p1", title: "Interviews", content: "old" })];
    await tool("update_doc").run(
      { product: "atlas", area: "research", docId: "p1", content: "new" },
      ctx,
    );
    expect(store.updateDocPage).toHaveBeenCalledWith(
      "p1",
      { content: "new" },
      ctx.scope,
    );
  });

  it("moves a page to the area root with a null parent", async () => {
    pages = [page({ id: "p1", parentId: "folder-1" })];
    await tool("update_doc").run(
      { product: "atlas", area: "research", docId: "p1", parentId: null },
      ctx,
    );
    expect(store.updateDocPage).toHaveBeenCalledWith(
      "p1",
      { parentId: null },
      ctx.scope,
    );
  });

  it("rejects a call that changes nothing", async () => {
    pages = [page({ id: "p1" })];
    await expect(
      tool("update_doc").run(
        { product: "atlas", area: "research", docId: "p1" },
        ctx,
      ),
    ).rejects.toThrow(/Nothing to update/);
  });

  it("renames a GitHub file, then writes the body at the new path", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    const out = (await tool("update_doc").run(
      {
        product: "atlas",
        area: "architecture",
        docId: "services/api.md",
        title: "Public API",
        content: "# Public API",
      },
      ctx,
    )) as { docId: string };

    expect(github.renameGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "services/api.md",
      "services/public-api.md",
    );
    // The sha the rename returned guards the content write; no extra read.
    expect(github.readGithubDocFile).not.toHaveBeenCalled();
    expect(github.saveGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "services/public-api.md",
      "# Public API",
      "sha-renamed",
    );
    expect(out.docId).toBe("services/public-api.md");
  });

  it("guards a GitHub body edit with the file's current sha", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    await tool("update_doc").run(
      {
        product: "atlas",
        area: "architecture",
        docId: "constitution.md",
        content: "# Rules v2",
      },
      ctx,
    );
    expect(github.renameGithubDocFile).not.toHaveBeenCalled();
    expect(github.saveGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "constitution.md",
      "# Rules v2",
      "sha-current",
    );
  });
});

describe("delete_doc", () => {
  it("deletes a page and reports it took nothing else with it", async () => {
    pages = [page({ id: "p1", title: "Interviews" })];
    const out = (await tool("delete_doc").run(
      { product: "atlas", area: "research", docId: "p1" },
      ctx,
    )) as { deleted: boolean; deletedChildren: number; title: string };

    expect(out).toMatchObject({
      deleted: true,
      deletedChildren: 0,
      title: "Interviews",
    });
    expect(store.deleteDocPage).toHaveBeenCalledWith("p1", ctx.scope);
  });

  it("refuses to delete a folder that still holds pages", async () => {
    pages = [
      page({ id: "f1", kind: "folder", title: "Discovery" }),
      page({ id: "p1", parentId: "f1" }),
      page({ id: "p2", parentId: "p1" }),
    ];
    await expect(
      tool("delete_doc").run(
        { product: "atlas", area: "research", docId: "f1" },
        ctx,
      ),
    ).rejects.toThrow(/contains 2 page\(s\)/);
    expect(store.deleteDocPage).not.toHaveBeenCalled();
  });

  it("deletes the whole subtree once that is confirmed", async () => {
    pages = [
      page({ id: "f1", kind: "folder", title: "Discovery" }),
      page({ id: "p1", parentId: "f1" }),
      page({ id: "p2", parentId: "p1" }),
    ];
    const out = (await tool("delete_doc").run(
      {
        product: "atlas",
        area: "research",
        docId: "f1",
        deleteChildren: true,
      },
      ctx,
    )) as { deletedChildren: number };

    expect(out.deletedChildren).toBe(2);
    expect(store.deleteDocPage).toHaveBeenCalledWith("f1", ctx.scope);
  });

  it("deletes a GitHub file guarded by the sha it just read", async () => {
    space = { ...space, mode: "github", repoId: "repo-1" };
    await tool("delete_doc").run(
      {
        product: "atlas",
        area: "architecture",
        docId: "services/api.md",
      },
      ctx,
    );
    expect(github.deleteGithubDocFile).toHaveBeenCalledWith(
      expect.anything(),
      "ws-1",
      expect.anything(),
      "services/api.md",
      "sha-current",
    );
  });
});
