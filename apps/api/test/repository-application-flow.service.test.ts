import { describe, expect, it, vi } from "vitest";

import {
  RepositoryApplicationFlowError,
  RepositoryApplicationFlowService,
  buildRepositoryApplicationFlow,
  inferApplicationFlowLayer,
} from "../src/services/repository-application-flow.service.js";
import type {
  RepositorySymbolGraphFile,
  RepositorySymbolGraphGateway,
  RepositorySymbolGraphSymbol,
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
  type: string,
  references: readonly string[] = [],
  startLine = 1,
  endLine = 5,
): RepositorySymbolGraphSymbol {
  return {
    id,
    fileId,
    name,
    type,
    references,
    startLine,
    endLine,
  };
}

const files = [
  file("file-route", "src/routes/users.ts"),
  file("file-controller", "src/controllers/user.controller.ts"),
  file("file-service", "src/services/user.service.ts"),
  file("file-model", "src/models/user.model.ts"),
];
const symbols = [
  symbol(
    "symbol-route",
    "file-route",
    "GET /users/:id",
    "express_route",
    ["getUser"],
  ),
  symbol(
    "symbol-controller",
    "file-controller",
    "getUser",
    "function",
    ["UserService"],
  ),
  symbol(
    "symbol-service",
    "file-service",
    "UserService",
    "class",
    ["UserModel"],
  ),
  symbol("symbol-model", "file-model", "UserModel", "variable"),
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

describe("application flow role inference", () => {
  it.each([
    ["express_route", "src/routes.ts", "route"],
    ["method", "src/controllers/user.ts", "controller"],
    ["method", "src/user.service.ts", "service"],
    ["variable", "src/models/user.ts", "model"],
    ["function", "src/helpers/user.ts", undefined],
  ] as const)("infers %s in %s as %s", (type, path, expected) => {
    expect(inferApplicationFlowLayer({ type }, path)).toBe(expected);
  });
});

describe("buildRepositoryApplicationFlow", () => {
  it("builds a complete route-controller-service-model flow", () => {
    const result = buildRepositoryApplicationFlow(files, symbols);

    expect(result.nodes.map(({ id, layer }) => ({ id, layer }))).toEqual([
      { id: "symbol-route", layer: "route" },
      { id: "symbol-controller", layer: "controller" },
      { id: "symbol-service", layer: "service" },
      { id: "symbol-model", layer: "model" },
    ]);
    expect(result.edges).toEqual([
      {
        source: "symbol-controller",
        target: "symbol-service",
        reference: "UserService",
        ambiguous: false,
      },
      {
        source: "symbol-route",
        target: "symbol-controller",
        reference: "getUser",
        ambiguous: false,
      },
      {
        source: "symbol-service",
        target: "symbol-model",
        reference: "UserModel",
        ambiguous: false,
      },
    ]);
    expect(result.flows).toEqual([
      {
        routeNodeId: "symbol-route",
        nodeIds: [
          "symbol-route",
          "symbol-controller",
          "symbol-service",
          "symbol-model",
        ],
        complete: true,
        stopsAt: "model",
      },
    ]);
    expect(result.stats).toMatchObject({
      routes: 1,
      controllers: 1,
      services: 1,
      models: 1,
      completeFlows: 1,
      flowsTruncated: false,
    });
  });

  it("promotes a directly referenced callable route handler to controller", () => {
    const routeFile = file("file-route", "src/routes.ts");
    const result = buildRepositoryApplicationFlow(
      [routeFile],
      [
        symbol("route", "file-route", "GET /health", "express_route", [
          "health",
        ]),
        symbol("handler", "file-route", "health", "function"),
      ],
    );

    expect(result.nodes.map(({ id, layer }) => ({ id, layer }))).toEqual([
      { id: "route", layer: "route" },
      { id: "handler", layer: "controller" },
    ]);
    expect(result.flows[0]).toMatchObject({
      nodeIds: ["route", "handler"],
      complete: false,
      stopsAt: "controller",
    });
  });

  it("rejects backward and same-layer references from architectural edges", () => {
    const result = buildRepositoryApplicationFlow(files, [
      symbols[0]!,
      { ...symbols[1]!, references: ["otherController"] },
      symbol(
        "other-controller",
        "file-controller",
        "otherController",
        "function",
        ["GET /users/:id"],
        10,
        15,
      ),
    ]);

    expect(result.edges).toEqual([
      {
        source: "symbol-route",
        target: "symbol-controller",
        reference: "getUser",
        ambiguous: false,
      },
    ]);
  });

  it("preserves ambiguous service definitions instead of guessing", () => {
    const duplicateService = symbol(
      "symbol-service-two",
      "file-service",
      "UserService",
      "service",
      ["UserModel"],
      20,
      30,
    );
    const result = buildRepositoryApplicationFlow(files, [
      ...symbols,
      duplicateService,
    ]);

    expect(
      result.edges.filter(
        (edge) =>
          edge.source === "symbol-controller" &&
          edge.reference === "UserService",
      ),
    ).toEqual([
      {
        source: "symbol-controller",
        target: "symbol-service",
        reference: "UserService",
        ambiguous: true,
      },
      {
        source: "symbol-controller",
        target: "symbol-service-two",
        reference: "UserService",
        ambiguous: true,
      },
    ]);
    expect(result.stats.ambiguousReferences).toBe(1);
    expect(result.flows).toHaveLength(2);
  });

  it("filters the graph to one exact route and its reachable layers", () => {
    const secondRoute = symbol(
      "symbol-second-route",
      "file-route",
      "POST /users",
      "express_route",
      ["createUser"],
      20,
      20,
    );
    const secondController = symbol(
      "symbol-second-controller",
      "file-controller",
      "createUser",
      "controller",
      [],
      20,
      30,
    );
    const result = buildRepositoryApplicationFlow(
      files,
      [...symbols, secondRoute, secondController],
      { route: "POST /users" },
    );

    expect(result.route).toBe("POST /users");
    expect(result.nodes.map((node) => node.id)).toEqual([
      "symbol-second-route",
      "symbol-second-controller",
    ]);
    expect(result.flows).toHaveLength(1);
  });

  it("returns a typed not-found error for an unknown route", () => {
    expect(() =>
      buildRepositoryApplicationFlow(files, symbols, {
        route: "DELETE /missing",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryApplicationFlowError>>({
        code: "ROUTE_NOT_FOUND",
      }),
    );
  });

  it("rejects a blank direct route filter", () => {
    expect(() =>
      buildRepositoryApplicationFlow(files, symbols, { route: "   " }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryApplicationFlowError>>({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("truncates deterministic flow enumeration at its output bound", () => {
    const result = buildRepositoryApplicationFlow(
      files,
      [
        symbols[0]!,
        {
          ...symbols[1]!,
          references: ["UserService", "AuditService"],
        },
        symbols[2]!,
        symbols[3]!,
        symbol(
          "symbol-audit-service",
          "file-service",
          "AuditService",
          "service",
          ["UserModel"],
          40,
          50,
        ),
      ],
      { maximumFlows: 1 },
    );

    expect(result.flows).toHaveLength(1);
    expect(result.stats.flowsTruncated).toBe(true);
  });

  it("bounds inspected references even when identifiers do not resolve", () => {
    expect(() =>
      buildRepositoryApplicationFlow(files, [
        { ...symbols[0]!, references: ["one", "two"] },
      ], { maximumReferences: 1 }),
    ).toThrowError(
      expect.objectContaining<Partial<RepositoryApplicationFlowError>>({
        code: "FLOW_TOO_LARGE",
      }),
    );
  });
});

describe("RepositoryApplicationFlowService", () => {
  it("loads only the owned repository's exact branch and indexed commit", async () => {
    const gateway = createGateway();
    const result = await new RepositoryApplicationFlowService(gateway).getFlow({
      authenticatedUserId: userId,
      repositoryId,
      route: "GET /users/:id",
    });

    expect(result).toMatchObject({
      repositoryId,
      branch: "main",
      commitSha,
      route: "GET /users/:id",
      stats: { completeFlows: 1 },
    });
    expect(gateway.listFiles).toHaveBeenCalledWith({
      repositoryId,
      branch: "main",
      commitSha,
      limit: 5_001,
    });
    expect(gateway.listSymbols).toHaveBeenCalledWith({
      repositoryId,
      fileIds: files.map((item) => item.id),
      limit: 10_001,
    });
  });

  it("fails closed before metadata access for unowned repositories", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue(null);

    await expect(
      new RepositoryApplicationFlowService(gateway).getFlow({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
    expect(gateway.listFiles).not.toHaveBeenCalled();
    expect(gateway.listSymbols).not.toHaveBeenCalled();
  });

  it("locks application flows until repository indexing is ready", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.findOwnedRepository).mockResolvedValue({
      id: repositoryId,
      branch: "main",
      status: "embedding",
    });

    await expect(
      new RepositoryApplicationFlowService(gateway).getFlow({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_READY" });
  });

  it("enforces file and symbol input limits", async () => {
    const fileGateway = createGateway();
    await expect(
      new RepositoryApplicationFlowService(fileGateway, {
        maximumFiles: 3,
      }).getFlow({ authenticatedUserId: userId, repositoryId }),
    ).rejects.toMatchObject({ code: "FLOW_TOO_LARGE" });

    const symbolGateway = createGateway();
    await expect(
      new RepositoryApplicationFlowService(symbolGateway, {
        maximumSymbols: 3,
      }).getFlow({ authenticatedUserId: userId, repositoryId }),
    ).rejects.toMatchObject({ code: "FLOW_TOO_LARGE" });
  });

  it("wraps metadata failures without exposing dependency details", async () => {
    const gateway = createGateway();
    vi.mocked(gateway.listSymbols).mockRejectedValue(
      new Error("mongodb://username:secret@internal/flows"),
    );

    await expect(
      new RepositoryApplicationFlowService(gateway).getFlow({
        authenticatedUserId: userId,
        repositoryId,
      }),
    ).rejects.toMatchObject({
      code: "FLOW_DATA_UNAVAILABLE",
      message: "Repository application flow metadata could not be loaded",
    });
  });
});
