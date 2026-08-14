import { describe, expect, it, vi } from "vitest";

import {
  RepositoryImportGraphError,
  RepositoryImportGraphService,
  buildRepositoryImportGraph,
  type RepositoryImportGraphFile,
  type RepositoryImportGraphGateway,
} from "../src/services/repository-import-graph.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "c".repeat(40);

function file(
  path: string,
  imports: readonly string[] = [],
  language = "typescript",
): RepositoryImportGraphFile {
  return { path, language, imports };
}

function createGateway(
  files: RepositoryImportGraphFile[] = [],
): RepositoryImportGraphGateway {
  return {
    findOwnedRepository: vi.fn().mockResolvedValue({
      id: repositoryId,
      branch: "main",
      status: "ready",
      lastIndexedCommit: commitSha,
    }),
    listFiles: vi.fn().mockResolvedValue(files),
  };
}

describe("buildRepositoryImportGraph", () => {
  it("resolves extensionless, directory-index, and emitted JavaScript imports", () => {
    const result = buildRepositoryImportGraph([
      file("src/runtime.ts"),
      file("src/directory/index.ts"),
      file("src/index.ts", [
        "./feature",
        "./directory",
        "./runtime.js",
        "express",
        "Feature",
      ]),
      file("src/feature.ts"),
    ]);

    expect(result.edges).toEqual([
      {
        source: "src/index.ts",
        target: "src/directory/index.ts",
        specifier: "./directory",
      },
      {
        source: "src/index.ts",
        target: "src/feature.ts",
        specifier: "./feature",
      },
      {
        source: "src/index.ts",
        target: "src/runtime.ts",
        specifier: "./runtime.js",
      },
    ]);
    expect(result.unresolvedImports).toEqual([]);
    expect(result.nodes.map((node) => node.path)).toEqual([
      "src/directory/index.ts",
      "src/feature.ts",
      "src/index.ts",
      "src/runtime.ts",
    ]);
    expect(result.nodes.find((node) => node.path === "src/index.ts")).toMatchObject({
      imports: 3,
      importedBy: 0,
    });
    expect(result.stats).toMatchObject({ files: 4, internalImports: 3 });
  });

  it("reports unresolved relative imports once and ignores package metadata", () => {
    const result = buildRepositoryImportGraph([
      file("src/index.ts", [
        "./missing",
        "./missing?raw",
        "../../outside",
        "node:path",
        "Router",
      ]),
    ]);

    expect(result.edges).toEqual([]);
    expect(result.unresolvedImports).toEqual([
      { source: "src/index.ts", specifier: "../../outside" },
      { source: "src/index.ts", specifier: "./missing" },
    ]);
    expect(result.stats.unresolvedInternalImports).toBe(2);
  });

  it("finds deterministic multi-file and self-import cycles", () => {
    const result = buildRepositoryImportGraph([
      file("src/self.ts", ["./self"]),
      file("src/b.ts", ["./a"]),
      file("src/a.ts", ["./b"]),
    ]);

    expect(result.cycles).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/self.ts"],
    ]);
    expect(result.nodes.every((node) => node.inCycle)).toBe(true);
    expect(result.stats).toMatchObject({ cyclicFiles: 3, cycleGroups: 2 });
  });

  it("rejects duplicate normalized file paths", () => {
    expect(() =>
      buildRepositoryImportGraph([file("src/index.ts"), file("src\\index.ts")]),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryImportGraphError>>({
        code: "GRAPH_DATA_INVALID",
      }),
    );
  });

  it("bounds the number of inspected internal imports", () => {
    expect(() =>
      buildRepositoryImportGraph(
        [file("src/index.ts", ["./one", "./two"])],
        1,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryImportGraphError>>({
        code: "GRAPH_TOO_LARGE",
      }),
    );
  });
});

describe("RepositoryImportGraphService", () => {
  it("loads only the owned ready repository branch and indexed commit", async () => {
    const gateway = createGateway([
      file("src/index.ts", ["./dependency"]),
      file("src/dependency.ts"),
    ]);
    const service = new RepositoryImportGraphService(gateway);

    const result = await service.getGraph({
      authenticatedUserId: userId,
      repositoryId,
    });

    expect(result).toMatchObject({
      repositoryId,
      branch: "main",
      commitSha,
      stats: { files: 2, internalImports: 1 },
    });
    expect(gateway.findOwnedRepository).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
    expect(gateway.listFiles).toHaveBeenCalledWith({
      repositoryId,
      branch: "main",
      commitSha,
      limit: 5_001,
    });
  });

  it("fails closed when the repository is not owned", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue(null);

    await expect(
      new RepositoryImportGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    expect(gateway.listFiles).not.toHaveBeenCalled();
  });

  it("locks the graph until the repository is fully indexed", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue({
      id: repositoryId,
      branch: "main",
      status: "embedding",
    });

    await expect(
      new RepositoryImportGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" });
    expect(gateway.listFiles).not.toHaveBeenCalled();
  });

  it("rejects repositories above the configured file bound", async () => {
    const gateway = createGateway([file("src/a.ts"), file("src/b.ts")]);
    const service = new RepositoryImportGraphService(gateway, {
      maximumFiles: 1,
    });

    await expect(
      service.getGraph({ authenticatedUserId: userId, repositoryId }),
    ).rejects.toMatchObject({ code: "GRAPH_TOO_LARGE" });
    expect(gateway.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
  });

  it("wraps storage failures without exposing their details", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listFiles).mockRejectedValue(
      new Error("mongodb://username:secret@internal/imports"),
    );

    await expect(
      new RepositoryImportGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({
      code: "GRAPH_DATA_UNAVAILABLE",
      message: "Repository import metadata could not be loaded",
    });
  });
});
