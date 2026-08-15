import { describe, expect, it, vi } from "vitest";

import {
  RepositoryArchitectureError,
  RepositoryArchitectureService,
  buildRepositoryArchitecture,
  escapeMermaidLabel,
} from "../src/services/repository-architecture.service.js";
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

const importGraph: RepositoryImportGraphResult = {
  repositoryId,
  branch: "main",
  commitSha,
  nodes: [
    {
      id: "src/routes.ts",
      path: "src/routes.ts",
      language: "typescript",
      imports: 1,
      importedBy: 0,
      inCycle: false,
    },
    {
      id: "src/service.ts",
      path: "src/service.ts",
      language: "typescript",
      imports: 0,
      importedBy: 1,
      inCycle: false,
    },
  ],
  edges: [
    {
      source: "src/routes.ts",
      target: "src/service.ts",
      specifier: "./service.js",
    },
  ],
  unresolvedImports: [],
  cycles: [],
  stats: {
    files: 2,
    internalImports: 1,
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
      id: "route",
      name: "GET /users",
      type: "express_route",
      filePath: "src/routes.ts",
      language: "typescript",
      startLine: 5,
      endLine: 5,
      references: 1,
      referencedBy: 0,
    },
    {
      id: "service",
      name: "listUsers",
      type: "service",
      filePath: "src/service.ts",
      language: "typescript",
      startLine: 10,
      endLine: 20,
      references: 0,
      referencedBy: 1,
    },
  ],
  edges: [
    { source: "route", target: "service", symbol: "listUsers" },
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
      id: "route",
      name: "GET /users",
      layer: "route",
      symbolType: "express_route",
      filePath: "src/routes.ts",
      language: "typescript",
      startLine: 5,
      endLine: 5,
      outgoing: 1,
      incoming: 0,
    },
    {
      id: "service",
      name: "listUsers",
      layer: "service",
      symbolType: "service",
      filePath: "src/service.ts",
      language: "typescript",
      startLine: 10,
      endLine: 20,
      outgoing: 0,
      incoming: 1,
    },
  ],
  edges: [
    {
      source: "route",
      target: "service",
      reference: "listUsers",
      ambiguous: false,
    },
  ],
  flows: [
    {
      routeNodeId: "route",
      nodeIds: ["route", "service"],
      complete: false,
      stopsAt: "service",
    },
  ],
  stats: {
    routes: 1,
    controllers: 0,
    services: 1,
    models: 0,
    edges: 1,
    flows: 1,
    completeFlows: 0,
    ambiguousReferences: 0,
    inspectedReferenceNames: 1,
    flowsTruncated: false,
  },
};

function dependencies(): {
  importGraphService: RepositoryImportGraphServiceContract;
  symbolGraphService: RepositorySymbolGraphServiceContract;
  applicationFlowService: RepositoryApplicationFlowServiceContract;
} {
  return {
    importGraphService: {
      getGraph: vi.fn().mockResolvedValue(importGraph),
    },
    symbolGraphService: {
      getGraph: vi.fn().mockResolvedValue(symbolGraph),
      findReferences: vi.fn(),
    },
    applicationFlowService: {
      getFlow: vi.fn().mockResolvedValue(applicationFlow),
    },
  };
}

describe("buildRepositoryArchitecture", () => {
  it("creates deterministic metrics, discovery lists, risks, and diagrams", () => {
    const result = buildRepositoryArchitecture({
      importGraph,
      symbolGraph,
      applicationFlow,
    });

    expect(result).toMatchObject({
      repositoryId,
      branch: "main",
      commitSha,
      summary: {
        metrics: {
          files: 2,
          languages: 1,
          internalImports: 1,
          symbols: 2,
          routes: 1,
          completeFlows: 0,
          incompleteFlows: 1,
        },
        languages: [{ name: "typescript", files: 2 }],
        entryPoints: [
          { name: "GET /users", filePath: "src/routes.ts", line: 5 },
        ],
        dependencyHubs: [
          {
            filePath: "src/service.ts",
            imports: 0,
            importedBy: 1,
            inCycle: false,
          },
          {
            filePath: "src/routes.ts",
            imports: 1,
            importedBy: 0,
            inCycle: false,
          },
        ],
      },
      diagrams: {
        imports: { nodes: 2, edges: 1, truncated: false },
        applicationFlow: { nodes: 2, edges: 1, truncated: false },
      },
    });
    expect(result.summary.overview).toContain("2 files and 2 symbols");
    expect(result.summary.risks).toContainEqual(
      expect.objectContaining({
        code: "INCOMPLETE_APPLICATION_FLOWS",
        count: 1,
      }),
    );
    expect(result.diagrams.imports.mermaid).toContain("F0 --> F1");
    expect(result.diagrams.applicationFlow.mermaid).toContain(
      'A0 -->|"listUsers"| A1',
    );
  });

  it("escapes adversarial repository labels before placing them in Mermaid", () => {
    const dangerousPath = 'src/a"]\n%%{init: {"theme":"dark"}}%%<script>.ts';
    const result = buildRepositoryArchitecture({
      importGraph: {
        ...importGraph,
        nodes: [
          {
            ...importGraph.nodes[0]!,
            id: dangerousPath,
            path: dangerousPath,
          },
        ],
        edges: [],
        stats: { ...importGraph.stats, files: 1, internalImports: 0 },
      },
      symbolGraph,
      applicationFlow,
    });

    expect(escapeMermaidLabel(dangerousPath)).not.toContain('"');
    expect(result.diagrams.imports.mermaid).toContain("&quot;");
    expect(result.diagrams.imports.mermaid).toContain("&lt;script&gt;");
    expect(result.diagrams.imports.mermaid).not.toContain("\n%%");
  });

  it("marks diagrams as truncated at configured display bounds", () => {
    const result = buildRepositoryArchitecture(
      { importGraph, symbolGraph, applicationFlow },
      { maximumDiagramNodes: 1, maximumDiagramEdges: 1 },
    );

    expect(result.diagrams.imports).toMatchObject({
      nodes: 1,
      edges: 0,
      truncated: true,
    });
    expect(result.diagrams.applicationFlow.truncated).toBe(true);
    expect(result.summary.risks).toContainEqual(
      expect.objectContaining({ code: "TRUNCATED_DIAGRAMS", count: 2 }),
    );
  });

  it("rejects graph sources from different indexed commits", () => {
    expect(() =>
      buildRepositoryArchitecture({
        importGraph,
        symbolGraph: { ...symbolGraph, commitSha: "d".repeat(40) },
        applicationFlow,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryArchitectureError>>({
        code: "ARCHITECTURE_DATA_INVALID",
      }),
    );
  });
});

describe("RepositoryArchitectureService", () => {
  it("loads all source graphs with the same authenticated scope", async () => {
    const sourceServices = dependencies();
    const service = new RepositoryArchitectureService(sourceServices);
    const result = await service.getArchitecture({
      authenticatedUserId: userId,
      repositoryId,
    });

    const expectedInput = { authenticatedUserId: userId, repositoryId };
    expect(sourceServices.importGraphService.getGraph).toHaveBeenCalledWith(
      expectedInput,
    );
    expect(sourceServices.symbolGraphService.getGraph).toHaveBeenCalledWith(
      expectedInput,
    );
    expect(sourceServices.applicationFlowService.getFlow).toHaveBeenCalledWith(
      expectedInput,
    );
    expect(result.repositoryId).toBe(repositoryId);
  });

  it("rejects malformed identity input before loading graph data", async () => {
    const sourceServices = dependencies();
    await expect(
      new RepositoryArchitectureService(sourceServices).getArchitecture({
        authenticatedUserId: "invalid",
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(sourceServices.importGraphService.getGraph).not.toHaveBeenCalled();
  });

  it("normalizes source limits without exposing internal causes", async () => {
    const sourceServices = dependencies();
    vi.mocked(sourceServices.importGraphService.getGraph).mockRejectedValue(
      new RepositoryImportGraphError(
        "GRAPH_TOO_LARGE",
        "Sensitive provider response",
        { cause: new Error("mongodb://username:secret@internal") },
      ),
    );

    await expect(
      new RepositoryArchitectureService(sourceServices).getArchitecture({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({
      code: "ARCHITECTURE_TOO_LARGE",
      message: "Repository architecture exceeds a configured safety limit",
    });
  });
});
