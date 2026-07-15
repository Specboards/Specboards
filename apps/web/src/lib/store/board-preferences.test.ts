import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBoard } from "@/lib/board-preferences-service";

import { LocalFileStore } from "./local";

describe("parseBoard", () => {
  it("accepts known board keys", () => {
    expect(parseBoard("backlog")).toBe("backlog");
    expect(parseBoard("roadmap")).toBe("roadmap");
  });

  it("falls back to backlog for anything unrecognized", () => {
    expect(parseBoard(undefined)).toBe("backlog");
    expect(parseBoard(null)).toBe("backlog");
    expect(parseBoard("")).toBe("backlog");
    expect(parseBoard("nope")).toBe("backlog");
    expect(parseBoard(42)).toBe("backlog");
  });
});

describe("LocalFileStore board preferences (per board)", () => {
  let root: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "specboard-prefs-"));
    store = new LocalFileStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null when nothing is saved", async () => {
    expect(await store.getBoardPreferences(undefined, "backlog")).toBeNull();
    expect(await store.getBoardPreferences(undefined, "roadmap")).toBeNull();
  });

  it("keeps each board's selection independent", async () => {
    await store.setBoardPreferences(
      { cardFields: ["tags"], featured: null },
      undefined,
      "backlog",
    );
    await store.setBoardPreferences(
      { cardFields: ["assignee", "release"], featured: "team" },
      undefined,
      "roadmap",
    );

    expect(await store.getBoardPreferences(undefined, "backlog")).toEqual({
      cardFields: ["tags"],
      featured: null,
    });
    expect(await store.getBoardPreferences(undefined, "roadmap")).toEqual({
      cardFields: ["assignee", "release"],
      featured: "team",
    });
  });

  it("writing one board leaves the other untouched", async () => {
    await store.setBoardPreferences(
      { cardFields: ["tags"], featured: null },
      undefined,
      "backlog",
    );
    await store.setBoardPreferences(
      { cardFields: ["epic"], featured: null },
      undefined,
      "roadmap",
    );
    // Backlog prefs survive the later roadmap write.
    expect(await store.getBoardPreferences(undefined, "backlog")).toEqual({
      cardFields: ["tags"],
      featured: null,
    });
  });

  it("reads a legacy flat file as the Backlog's prefs", async () => {
    // Pre per-board format: a bare BoardPreferences object on disk.
    const prefsPath = path.join(root, ".specboard", "local-board-prefs.json");
    await fs.mkdir(path.dirname(prefsPath), { recursive: true });
    await fs.writeFile(
      prefsPath,
      JSON.stringify({ cardFields: ["blocked", "tags"], featured: "prio" }),
      "utf8",
    );

    expect(await store.getBoardPreferences(undefined, "backlog")).toEqual({
      cardFields: ["blocked", "tags"],
      featured: "prio",
    });
    expect(await store.getBoardPreferences(undefined, "roadmap")).toBeNull();

    // A roadmap write migrates the file to the map format without losing the
    // legacy backlog selection.
    await store.setBoardPreferences(
      { cardFields: ["epic"], featured: null },
      undefined,
      "roadmap",
    );
    expect(await store.getBoardPreferences(undefined, "backlog")).toEqual({
      cardFields: ["blocked", "tags"],
      featured: "prio",
    });
    expect(await store.getBoardPreferences(undefined, "roadmap")).toEqual({
      cardFields: ["epic"],
      featured: null,
    });
  });

  it("defaults to the backlog board when none is passed", async () => {
    await store.setBoardPreferences({ cardFields: ["sub"], featured: null });
    expect(await store.getBoardPreferences()).toEqual({
      cardFields: ["sub"],
      featured: null,
    });
    expect(await store.getBoardPreferences(undefined, "roadmap")).toBeNull();
  });
});
