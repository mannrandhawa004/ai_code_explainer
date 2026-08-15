import { describe, expect, it, vi } from "vitest";

import {
  RepositoryDependencyExplorationError,
  RepositoryDependencyExplorationService,
  buildRepositoryDependencyExploration,
  buildRepositoryRelatedFileSuggestions,
} from "../src/services/repository-dependency-exploration.service.js";
import {
  RepositoryImportGraphError,
  type RepositoryImportGraphResult,
  type RepositoryImportGraphServiceContract,
} from "../src/services/repository-import-graph.service.js";
import type {
  RepositorySymbolGraphResult,
  RepositorySymbolGraphServiceContract,
} from "../src/services/repository-symbol-graph.service.js";
import type {
  RepositoryApplicationFlowResult,
  RepositoryApplicationFlowServiceContract,
} from "../src/services/repository-application-flow.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "c".repeat(40);

function importNode(
  filePath: string,
  imports: number,
  importedBy: number,
) {
  return {
    id: filePath,
    path: filePath,
    language: "typescript",
    imports,
    importedBy,
    inCycle: false,
  };
}

const importGraph: RepositoryImportGraphResult = {
  repositoryId,
  branch: "main",
  commitSha,
  nodes: [
    importNode("src/a.ts", 2, 1),
    importNode("src/b.ts", 1, 2),
    importNode("src/c.ts", 1, 1),
    importNode("src/d.ts", 0, 1),
    importNode("src/e.ts", 1, 1),
    importNode("src/f.ts", 1, 0),
    importNode("src/x.ts", 1, 0),
  ],
  edges: [
    { source: "src/a.ts", target: "src/b.ts", specifier: "./b.js" },
    { source: "src/a.ts", target: "src/c.ts", specifier: "./c.js" },
    { source: "src/b.ts", target: "src/d.ts", specifier: "./d.js" },
    { source: "src/c.ts", target: "src/d.ts", specifier: "./d.js" },
    { source: "src/e.ts", target: "src/a.ts", specifier: "./a.js" },
    { source: "src/f.ts", target: "src/e.ts", specifier: "./e.js" },
    { source: "src/x.ts", target: "src/b.ts", specifier: "./b.js" },
  ],
  unresolvedImports: [],
  cycles: [],
  stats: {
    files: 7,
    internalImports: 7,
    unresolvedInternalImports: 0,
    cyclicFiles: 0,
    cycleGroups: 0,
  },
};

const symbolGraph: RepositorySymbolGraphResult = {
  repositoryId,
  branch: "main",
  commitSha,
  nodes: [
    {
      id: "symbol-a",
      name: "routeA",
      type: "express_route",
      filePath: "src/a.ts",
      language: "typescript",
      startLine: 1,
      endLine: 2,
      references: 1,
      referencedBy: 0,
    },
    {
      id: "symbol-b",
      name: "controllerB",
      type: "controller",
      filePath: "src/b.ts",
      language: "typescript",
      startLine: 3,
      endLine: 8,
      references: 0,
      referencedBy: 1,
    },
  ],
  edges: [
    { source: "symbol-a", target: "symbol-b", symbol: "controllerB" },
  ],
  stats: {
    files: 2,
    symbols: 2,
    resolvedReferences: 1,
    inspectedReferenceNames: 1,
    referencedSymbols: 1,
    ambiguousReferences: 0,
  },
};

const applicationFlow: RepositoryApplicationFlowResult = {
  repositoryId,
  branch: "main",
  commitSha,
  nodes: [
    {
      id: "flow-a",
      name: "GET /a",
      layer: "route",
      symbolType: "express_route",
      filePath: "src/a.ts",
      language: "typescript",
      startLine: 1,
      endLine: 1,
      outgoing: 1,
      incoming: 0,
    },
    {
      id: "flow-b",
      name: "controllerB",
      layer: "controller",
      symbolType: "controller",
      filePath: "src/b.ts",
      language: "typescript",
      startLine: 3,
      endLine: 8,
      outgoing: 1,
      incoming: 1,
    },
    {
      id: "flow-c",
      name: "serviceC",
      layer: "service",
      symbolType: "service",
      filePath: "src/c.ts",
      language: "typescript",
      startLine: 10,
      endLine: 20,
      outgoing: 1,
      incoming: 1,
    },
    {
      id: "flow-d",
      name: "modelD",
      layer: "model",
      symbolType: "model",
      filePath: "src/d.ts",
      language: "typescript",
      startLine: 1,
      endLine: 10,
      outgoing: 0,
      incoming: 1,
    },
  ],
  edges: [
    {
      source: "flow-a",
      target: "flow-b",
      reference: "controllerB",
      ambiguous: false,
    },
    {
      source: "flow-b",
      target: "flow-c",
      reference: "serviceC",
      ambiguous: false,
    },
    {
      source: "flow-c",
      target: "flow-d",
      reference: "modelD",
      ambiguous: false,
    },
  ],
  flows: [
    {
      routeNodeId: "flow-a",
      nodeIds: ["flow-a", "flow-b", "flow-c", "flow-d"],
      complete: true,
      stopsAt: "model",
    },
  ],
  stats: {
    routes: 1,
    controllers: 1,
    services: 1,
    models: 1,
    edges: 3,
    flows: 1,
    completeFlows: 1,
    ambiguousReferences: 0,
    inspectedReferenceNames: 3,
    flowsTruncated: false,
  },
};

function dependencies(): {
  importGraphService: RepositoryImportGraphServiceContract;
  symbolGraphService: RepositorySymbolGraphServiceContract;
  applicationFlowService: RepositoryApplicationFlowServiceContract;
} {
  return {
    importGraphService: { getGraph: vi.fn().mockResolvedValue(importGraph) },
    symbolGraphService: {
      getGraph: vi.fn().mockResolvedValue(symbolGraph),
      findReferences: vi.fn(),
    },
    applicationFlowService: {
      getFlow: vi.fn().mockResolvedValue(applicationFlow),
    },
  };
}

describe("buildRepositoryDependencyExploration", () => {
  it("walks imports and dependents to a deterministic bounded depth", () => {
    const result = buildRepositoryDependencyExploration(importGraph, {
      filePath: "src/a.ts",
      direction: "both",
      depth: 2,
    });

    expect(
      result.nodes.map(({ path, distance, relation }) => ({
        path,
        distance,
        relation,
      })),
    ).toEqual([
      { path: "src/a.ts", distance: 0, relation: "origin" },
      { path: "src/b.ts", distance: 1, relation: "dependency" },
      { path: "src/c.ts", distance: 1, relation: "dependency" },
      { path: "src/e.ts", distance: 1, relation: "dependent" },
      { path: "src/d.ts", distance: 2, relation: "dependency" },
      { path: "src/f.ts", distance: 2, relation: "dependent" },
      { path: "src/x.ts", distance: 2, relation: "dependency" },
    ]);
    expect(result.stats).toMatchObject({
      returnedFiles: 7,
      returnedEdges: 7,
      truncated: false,
    });
  });

  it("supports one-way traversal and normalizes Windows path separators", () => {
    const result = buildRepositoryDependencyExploration(importGraph, {
      filePath: "src\\a.ts",
      direction: "imports",
      depth: 1,
    });

    expect(result.origin).toBe("src/a.ts");
    expect(result.nodes.map((node) => node.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("reports truncation rather than returning an unbounded graph", () => {
    const result = buildRepositoryDependencyExploration(
      importGraph,
      { filePath: "src/a.ts", direction: "both", depth: 2 },
      { maximumNodes: 3, maximumEdges: 1 },
    );

    expect(result.nodes.map((node) => node.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(result.edges).toHaveLength(1);
    expect(result.stats.truncated).toBe(true);
  });

  it("returns a typed error for an unknown or unsafe file path", () => {
    expect(() =>
      buildRepositoryDependencyExploration(importGraph, {
        filePath: "src/missing.ts",
        direction: "both",
        depth: 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryDependencyExplorationError>>({
        code: "FILE_NOT_FOUND",
      }),
    );
    expect(() =>
      buildRepositoryDependencyExploration(importGraph, {
        filePath: "../../outside.ts",
        direction: "both",
        depth: 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryDependencyExplorationError>>({
        code: "INVALID_REQUEST",
      }),
    );
  });
});

describe("buildRepositoryRelatedFileSuggestions", () => {
  it("ranks related files with transparent import, symbol, and flow reasons", () => {
    const result = buildRepositoryRelatedFileSuggestions(
      { importGraph, symbolGraph, applicationFlow },
      "src/a.ts",
      10,
    );

    expect(result.suggestions.map(({ filePath, score }) => ({ filePath, score })))
      .toEqual([
        { filePath: "src/b.ts", score: 330 },
        { filePath: "src/c.ts", score: 160 },
        { filePath: "src/d.ts", score: 100 },
        { filePath: "src/e.ts", score: 95 },
        { filePath: "src/f.ts", score: 35 },
        { filePath: "src/x.ts", score: 30 },
      ]);
    expect(result.suggestions[0]?.reasons.map((reason) => reason.code)).toEqual([
      "DIRECT_IMPORT",
      "APPLICATION_FLOW",
      "SYMBOL_REFERENCE",
      "SAME_APPLICATION_FLOW",
    ]);
    expect(result.stats).toMatchObject({
      consideredFiles: 6,
      matchingFiles: 6,
      returnedFiles: 6,
      truncated: false,
    });
  });

  it("applies the suggestion limit deterministically and reports truncation", () => {
    const result = buildRepositoryRelatedFileSuggestions(
      { importGraph, symbolGraph, applicationFlow },
      "src/a.ts",
      2,
    );

    expect(result.suggestions.map((suggestion) => suggestion.filePath)).toEqual([
      "src/b.ts",
      "src/c.ts",
    ]);
    expect(result.stats.truncated).toBe(true);
  });

  it("rejects graph sources from different indexed commits", () => {
    expect(() =>
      buildRepositoryRelatedFileSuggestions(
        {
          importGraph,
          symbolGraph: { ...symbolGraph, commitSha: "d".repeat(40) },
          applicationFlow,
        },
        "src/a.ts",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryDependencyExplorationError>>({
        code: "DEPENDENCY_DATA_INVALID",
      }),
    );
  });
});

describe("RepositoryDependencyExplorationService", () => {
  it("loads only the import graph for dependency traversal", async () => {
    const sourceServices = dependencies();
    const service = new RepositoryDependencyExplorationService(sourceServices);
    const result = await service.exploreDependencies({
      authenticatedUserId: userId,
      repositoryId,
      filePath: "src/a.ts",
      direction: "imports",
      depth: 1,
    });

    expect(sourceServices.importGraphService.getGraph).toHaveBeenCalledWith({
      authenticatedUserId: userId,
      repositoryId,
    });
    expect(sourceServices.symbolGraphService.getGraph).not.toHaveBeenCalled();
    expect(sourceServices.applicationFlowService.getFlow).not.toHaveBeenCalled();
    expect(result.nodes).toHaveLength(3);
  });

  it("loads all exact-scope graphs for related-file suggestions", async () => {
    const sourceServices = dependencies();
    const service = new RepositoryDependencyExplorationService(sourceServices);
    await service.suggestRelatedFiles({
      authenticatedUserId: userId,
      repositoryId,
      filePath: "src/a.ts",
      limit: 3,
    });

    const scope = { authenticatedUserId: userId, repositoryId };
    expect(sourceServices.importGraphService.getGraph).toHaveBeenCalledWith(scope);
    expect(sourceServices.symbolGraphService.getGraph).toHaveBeenCalledWith(scope);
    expect(sourceServices.applicationFlowService.getFlow).toHaveBeenCalledWith(
      scope,
    );
  });

  it("rejects malformed identity input before loading source graphs", async () => {
    const sourceServices = dependencies();
    await expect(
      new RepositoryDependencyExplorationService(
        sourceServices,
      ).exploreDependencies({
        authenticatedUserId: "invalid",
        repositoryId,
        filePath: "src/a.ts",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(sourceServices.importGraphService.getGraph).not.toHaveBeenCalled();
  });

  it("normalizes source failures without exposing internal causes", async () => {
    const sourceServices = dependencies();
    vi.mocked(sourceServices.importGraphService.getGraph).mockRejectedValue(
      new RepositoryImportGraphError(
        "GRAPH_DATA_UNAVAILABLE",
        "Sensitive database response",
        { cause: new Error("mongodb://username:secret@internal") },
      ),
    );

    await expect(
      new RepositoryDependencyExplorationService(
        sourceServices,
      ).exploreDependencies({
        authenticatedUserId: userId,
        repositoryId,
        filePath: "src/a.ts",
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_DATA_UNAVAILABLE",
      message: "Repository dependency metadata could not be loaded",
    });
  });
});
