import { describe, expect, it, vi } from "vitest";

import {
  RepositorySymbolGraphError,
  RepositorySymbolGraphService,
  buildRepositorySymbolGraph,
  type RepositorySymbolGraphFile,
  type RepositorySymbolGraphGateway,
  type RepositorySymbolGraphSymbol,
} from "../src/services/repository-symbol-graph.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const commitSha = "c".repeat(40);

function file(
  id: string,
  path: string,
  language = "typescript",
): RepositorySymbolGraphFile {
  return { id, path, language };
}

function symbol(
  id: string,
  fileId: string,
  name: string,
  references: readonly string[] = [],
  options: { type?: string; startLine?: number; endLine?: number } = {},
): RepositorySymbolGraphSymbol {
  return {
    id,
    fileId,
    name,
    type: options.type ?? "function",
    startLine: options.startLine ?? 1,
    endLine: options.endLine ?? 5,
    references,
  };
}

const files = [
  file("file-auth", "src/auth.ts"),
  file("file-middleware", "src/middleware.ts"),
  file("file-route", "src/routes.ts"),
];
const symbols = [
  symbol("symbol-auth", "file-auth", "authenticate"),
  symbol("symbol-middleware", "file-middleware", "requireAuth", [
    "authenticate",
    "request",
  ]),
  symbol("symbol-route", "file-route", "getUser", [
    "requireAuth",
    "authenticate",
  ]),
];

function createGateway(
  graphFiles: RepositorySymbolGraphFile[] = files,
  graphSymbols: RepositorySymbolGraphSymbol[] = symbols,
): RepositorySymbolGraphGateway {
  return {
    findOwnedRepository: vi.fn().mockResolvedValue({
      id: repositoryId,
      branch: "main",
      status: "ready",
      lastIndexedCommit: commitSha,
    }),
    listFiles: vi.fn().mockResolvedValue(graphFiles),
    listSymbols: vi.fn().mockResolvedValue(graphSymbols),
  };
}

describe("buildRepositorySymbolGraph", () => {
  it("builds deterministic resolved reference edges and node degrees", () => {
    const result = buildRepositorySymbolGraph(files, symbols);

    expect(result.edges).toEqual([
      {
        source: "symbol-middleware",
        target: "symbol-auth",
        symbol: "authenticate",
      },
      {
        source: "symbol-route",
        target: "symbol-auth",
        symbol: "authenticate",
      },
      {
        source: "symbol-route",
        target: "symbol-middleware",
        symbol: "requireAuth",
      },
    ]);
    expect(result.nodes.find((node) => node.id === "symbol-auth")).toMatchObject({
      references: 0,
      referencedBy: 2,
    });
    expect(result.nodes.find((node) => node.id === "symbol-route")).toMatchObject({
      references: 2,
      referencedBy: 0,
    });
    expect(result.stats).toEqual({
      files: 3,
      symbols: 3,
      resolvedReferences: 3,
      inspectedReferenceNames: 4,
      referencedSymbols: 2,
      ambiguousReferences: 0,
    });
  });

  it("reports ambiguous references without guessing one definition", () => {
    const result = buildRepositorySymbolGraph(
      files,
      [
        ...symbols,
        symbol("symbol-auth-copy", "file-route", "authenticate", [], {
          startLine: 20,
          endLine: 25,
        }),
      ],
    );

    expect(
      result.edges.filter((edge) => edge.symbol === "authenticate"),
    ).toHaveLength(4);
    expect(result.stats.ambiguousReferences).toBe(2);
  });

  it("ignores local or external identifiers with no indexed definition", () => {
    const result = buildRepositorySymbolGraph(
      [file("file-one", "src/one.ts")],
      [symbol("symbol-one", "file-one", "run", ["console", "value"])],
    );

    expect(result.edges).toEqual([]);
    expect(result.nodes[0]).toMatchObject({ references: 0, referencedBy: 0 });
  });

  it("keeps recursive self-references", () => {
    const result = buildRepositorySymbolGraph(
      [file("file-factorial", "src/factorial.ts")],
      [symbol("symbol-factorial", "file-factorial", "factorial", ["factorial"])],
    );

    expect(result.edges).toEqual([
      {
        source: "symbol-factorial",
        target: "symbol-factorial",
        symbol: "factorial",
      },
    ]);
  });

  it("rejects symbols that do not belong to a current scoped file", () => {
    expect(() =>
      buildRepositorySymbolGraph(
        [file("file-one", "src/one.ts")],
        [symbol("symbol-one", "other-file", "run")],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RepositorySymbolGraphError>>({
        code: "SYMBOL_DATA_INVALID",
      }),
    );
  });

  it("bounds the number of resolved edges", () => {
    expect(() =>
      buildRepositorySymbolGraph(
        [file("file-one", "src/one.ts"), file("file-two", "src/two.ts")],
        [
          symbol("symbol-one", "file-one", "one", ["two"]),
          symbol("symbol-two", "file-two", "two", ["one"]),
        ],
        1,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RepositorySymbolGraphError>>({
        code: "SYMBOL_GRAPH_TOO_LARGE",
      }),
    );
  });

  it("bounds inspected identifiers even when they do not resolve", () => {
    expect(() =>
      buildRepositorySymbolGraph(
        [file("file-one", "src/one.ts")],
        [symbol("symbol-one", "file-one", "one", ["localOne", "localTwo"])],
        10,
        1,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RepositorySymbolGraphError>>({
        code: "SYMBOL_GRAPH_TOO_LARGE",
      }),
    );
  });
});

describe("RepositorySymbolGraphService", () => {
  it("scopes graph data to the owned branch and exact indexed commit", async () => {
    const gateway = createGateway();
    const result = await new RepositorySymbolGraphService(gateway).getGraph({
      authenticatedUserId: userId,
      repositoryId,
    });

    expect(result).toMatchObject({
      repositoryId,
      branch: "main",
      commitSha,
      stats: { symbols: 3, resolvedReferences: 3 },
    });
    expect(gateway.listFiles).toHaveBeenCalledWith({
      repositoryId,
      branch: "main",
      commitSha,
      limit: 5_001,
    });
    expect(gateway.listSymbols).toHaveBeenCalledWith({
      repositoryId,
      fileIds: ["file-auth", "file-middleware", "file-route"],
      limit: 10_001,
    });
  });

  it("returns definitions and unique enclosing usage sites", async () => {
    const result = await new RepositorySymbolGraphService(
      createGateway(),
    ).findReferences({
      authenticatedUserId: userId,
      repositoryId,
      symbol: " authenticate ",
    });

    expect(result).toMatchObject({
      symbol: "authenticate",
      ambiguous: false,
      stats: { definitions: 1, references: 2, files: 2 },
    });
    expect(result.definitions.map((definition) => definition.id)).toEqual([
      "symbol-auth",
    ]);
    expect(result.references.map((reference) => reference.id)).toEqual([
      "symbol-middleware",
      "symbol-route",
    ]);
  });

  it("marks lookup results ambiguous when names have multiple definitions", async () => {
    const gateway = createGateway(files, [
      ...symbols,
      symbol("symbol-auth-copy", "file-route", "authenticate", [], {
        startLine: 20,
        endLine: 25,
      }),
    ]);

    const result = await new RepositorySymbolGraphService(
      gateway,
    ).findReferences({
      authenticatedUserId: userId,
      repositoryId,
      symbol: "authenticate",
    });

    expect(result.ambiguous).toBe(true);
    expect(result.definitions).toHaveLength(2);
    expect(result.references).toHaveLength(2);
  });

  it("returns not found for identifiers without a definition", async () => {
    await expect(
      new RepositorySymbolGraphService(createGateway()).findReferences({
        authenticatedUserId: userId,
        repositoryId,
        symbol: "missingSymbol",
      }),
    ).rejects.toMatchObject({ code: "SYMBOL_NOT_FOUND" });
  });

  it("fails closed before loading files when the repository is not owned", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue(null);

    await expect(
      new RepositorySymbolGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    expect(gateway.listFiles).not.toHaveBeenCalled();
    expect(gateway.listSymbols).not.toHaveBeenCalled();
  });

  it("locks graph access until indexing is ready", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue({
      id: repositoryId,
      branch: "main",
      status: "parsing",
    });

    await expect(
      new RepositorySymbolGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" });
    expect(gateway.listFiles).not.toHaveBeenCalled();
  });

  it("bounds symbol and lookup result counts", async () => {
    const gateway = createGateway();
    const symbolBoundService = new RepositorySymbolGraphService(gateway, {
      maximumSymbols: 2,
    });
    await expect(
      symbolBoundService.getGraph({ authenticatedUserId: userId, repositoryId }),
    ).rejects.toMatchObject({ code: "SYMBOL_GRAPH_TOO_LARGE" });

    const lookupBoundService = new RepositorySymbolGraphService(
      createGateway(),
      { maximumLookupReferences: 1 },
    );
    await expect(
      lookupBoundService.findReferences({
        authenticatedUserId: userId,
        repositoryId,
        symbol: "authenticate",
      }),
    ).rejects.toMatchObject({ code: "SYMBOL_GRAPH_TOO_LARGE" });
  });

  it("wraps persistence failures without exposing dependency details", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listSymbols).mockRejectedValue(
      new Error("mongodb://username:secret@internal/symbols"),
    );

    await expect(
      new RepositorySymbolGraphService(gateway).getGraph({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({
      code: "SYMBOL_DATA_UNAVAILABLE",
      message: "Repository symbol metadata could not be loaded",
    });
  });
});
