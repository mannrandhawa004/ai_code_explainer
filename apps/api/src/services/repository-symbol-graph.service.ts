import {
  RepositoryFileModel,
  RepositoryModel,
  SymbolModel,
} from "@codebase-explainer/database";
import mongoose from "mongoose";

const { Types, trusted } = mongoose;

export const defaultMaximumRepositorySymbolGraphFiles = 5_000;
export const defaultMaximumRepositorySymbolGraphSymbols = 10_000;
export const defaultMaximumRepositorySymbolGraphReferences = 100_000;
export const defaultMaximumRepositorySymbolGraphEdges = 50_000;
export const defaultMaximumRepositorySymbolLookupReferences = 1_000;

const objectIdPattern = /^[0-9a-f]{24}$/iu;

export type RepositorySymbolGraphRecord = {
  id: string;
  branch: string;
  status: string;
  lastIndexedCommit?: string;
};

export type RepositorySymbolGraphFile = {
  id: string;
  path: string;
  language: string;
};

export type RepositorySymbolGraphSymbol = {
  id: string;
  fileId: string;
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  references: readonly string[];
};

export type RepositorySymbolGraphNode = {
  id: string;
  name: string;
  type: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  references: number;
  referencedBy: number;
};

export type RepositorySymbolGraphEdge = {
  source: string;
  target: string;
  symbol: string;
};

export type RepositorySymbolGraphStats = {
  files: number;
  symbols: number;
  resolvedReferences: number;
  inspectedReferenceNames: number;
  referencedSymbols: number;
  ambiguousReferences: number;
};

export type RepositorySymbolGraphResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  nodes: RepositorySymbolGraphNode[];
  edges: RepositorySymbolGraphEdge[];
  stats: RepositorySymbolGraphStats;
};

export type RepositorySymbolReferenceResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  symbol: string;
  ambiguous: boolean;
  definitions: RepositorySymbolGraphNode[];
  references: RepositorySymbolGraphNode[];
  stats: {
    definitions: number;
    references: number;
    files: number;
  };
};

export interface RepositorySymbolGraphGateway {
  findOwnedRepository(input: {
    repositoryId: string;
    authenticatedUserId: string;
  }): Promise<RepositorySymbolGraphRecord | null>;
  listFiles(input: {
    repositoryId: string;
    branch: string;
    commitSha: string;
    limit: number;
  }): Promise<RepositorySymbolGraphFile[]>;
  listSymbols(input: {
    repositoryId: string;
    fileIds: readonly string[];
    limit: number;
  }): Promise<RepositorySymbolGraphSymbol[]>;
}

export interface RepositorySymbolGraphServiceContract {
  getGraph(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositorySymbolGraphResult>;
  findReferences(input: {
    authenticatedUserId: string;
    repositoryId: string;
    symbol: string;
  }): Promise<RepositorySymbolReferenceResult>;
}

export type RepositorySymbolGraphErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_NOT_READY"
  | "REPOSITORY_ACCESS_FAILED"
  | "SYMBOL_DATA_UNAVAILABLE"
  | "SYMBOL_DATA_INVALID"
  | "SYMBOL_GRAPH_TOO_LARGE"
  | "SYMBOL_NOT_FOUND";

export class RepositorySymbolGraphError extends Error {
  override readonly name = "RepositorySymbolGraphError";

  constructor(
    readonly code: RepositorySymbolGraphErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type BuiltSymbolGraph = Pick<
  RepositorySymbolGraphResult,
  "nodes" | "edges" | "stats"
> & {
  referenceNamesByNodeId: ReadonlyMap<string, ReadonlySet<string>>;
};

type LoadedSymbolScope = {
  repository: Required<
    Pick<
      RepositorySymbolGraphRecord,
      "id" | "branch" | "status" | "lastIndexedCommit"
    >
  >;
  files: RepositorySymbolGraphFile[];
  symbols: RepositorySymbolGraphSymbol[];
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function safeMetadataString(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new RepositorySymbolGraphError(
      "SYMBOL_DATA_INVALID",
      "Indexed repository symbol metadata is invalid",
    );
  }
  return normalized;
}

function compareNodes(
  left: RepositorySymbolGraphNode,
  right: RepositorySymbolGraphNode,
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.type.localeCompare(right.type) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

export function buildRepositorySymbolGraph(
  files: readonly RepositorySymbolGraphFile[],
  symbols: readonly RepositorySymbolGraphSymbol[],
  maximumEdges = defaultMaximumRepositorySymbolGraphEdges,
  maximumReferences = defaultMaximumRepositorySymbolGraphReferences,
): BuiltSymbolGraph {
  assertPositiveInteger(maximumEdges, "maximumEdges");
  assertPositiveInteger(maximumReferences, "maximumReferences");
  const filesById = new Map<string, RepositorySymbolGraphFile>();
  for (const file of files) {
    const id = safeMetadataString(file.id);
    if (filesById.has(id)) {
      throw new RepositorySymbolGraphError(
        "SYMBOL_DATA_INVALID",
        "Indexed repository symbol metadata is invalid",
      );
    }
    filesById.set(id, {
      id,
      path: safeMetadataString(file.path),
      language: safeMetadataString(file.language),
    });
  }

  const rawSymbolsById = new Map<string, RepositorySymbolGraphSymbol>();
  const definitionsByName = new Map<string, string[]>();
  const referenceNamesByNodeId = new Map<string, ReadonlySet<string>>();
  const nodes: RepositorySymbolGraphNode[] = [];
  for (const symbol of symbols) {
    const id = safeMetadataString(symbol.id);
    const file = filesById.get(safeMetadataString(symbol.fileId));
    const name = safeMetadataString(symbol.name);
    const type = safeMetadataString(symbol.type);
    if (
      file === undefined ||
      rawSymbolsById.has(id) ||
      !Number.isSafeInteger(symbol.startLine) ||
      symbol.startLine <= 0 ||
      !Number.isSafeInteger(symbol.endLine) ||
      symbol.endLine < symbol.startLine
    ) {
      throw new RepositorySymbolGraphError(
        "SYMBOL_DATA_INVALID",
        "Indexed repository symbol metadata is invalid",
      );
    }

    const referenceNames = new Set(
      symbol.references.map(safeMetadataString),
    );
    rawSymbolsById.set(id, { ...symbol, id, fileId: file.id, name, type });
    referenceNamesByNodeId.set(id, referenceNames);
    const definitions = definitionsByName.get(name) ?? [];
    definitions.push(id);
    definitionsByName.set(name, definitions);
    nodes.push({
      id,
      name,
      type,
      filePath: file.path,
      language: file.language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      references: 0,
      referencedBy: 0,
    });
  }

  for (const definitions of definitionsByName.values()) {
    definitions.sort((left, right) => left.localeCompare(right));
  }

  const edges: RepositorySymbolGraphEdge[] = [];
  let ambiguousReferences = 0;
  let inspectedReferenceNames = 0;
  for (const node of nodes) {
    const referenceNames = referenceNamesByNodeId.get(node.id) ?? new Set();
    for (const referenceName of [...referenceNames].sort((left, right) =>
      left.localeCompare(right),
    )) {
      inspectedReferenceNames += 1;
      if (inspectedReferenceNames > maximumReferences) {
        throw new RepositorySymbolGraphError(
          "SYMBOL_GRAPH_TOO_LARGE",
          "The repository symbol graph exceeds the configured reference limit",
        );
      }
      const targets = definitionsByName.get(referenceName) ?? [];
      if (targets.length > 1) {
        ambiguousReferences += 1;
      }
      for (const target of targets) {
        if (edges.length >= maximumEdges) {
          throw new RepositorySymbolGraphError(
            "SYMBOL_GRAPH_TOO_LARGE",
            "The repository symbol graph exceeds the configured edge limit",
          );
        }
        edges.push({ source: node.id, target, symbol: referenceName });
      }
    }
  }

  edges.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.symbol.localeCompare(right.symbol),
  );
  const outgoing = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const completedNodes = nodes
    .map((node) => ({
      ...node,
      references: outgoing.get(node.id) ?? 0,
      referencedBy: incoming.get(node.id) ?? 0,
    }))
    .sort(compareNodes);

  return {
    nodes: completedNodes,
    edges,
    stats: {
      files: new Set(completedNodes.map((node) => node.filePath)).size,
      symbols: completedNodes.length,
      resolvedReferences: edges.length,
      inspectedReferenceNames,
      referencedSymbols: completedNodes.filter((node) => node.referencedBy > 0)
        .length,
      ambiguousReferences,
    },
    referenceNamesByNodeId,
  };
}

export class RepositorySymbolGraphService
  implements RepositorySymbolGraphServiceContract
{
  private readonly maximumFiles: number;
  private readonly maximumSymbols: number;
  private readonly maximumReferences: number;
  private readonly maximumEdges: number;
  private readonly maximumLookupReferences: number;

  constructor(
    private readonly gateway: RepositorySymbolGraphGateway,
    options: {
      maximumFiles?: number;
      maximumSymbols?: number;
      maximumReferences?: number;
      maximumEdges?: number;
      maximumLookupReferences?: number;
    } = {},
  ) {
    this.maximumFiles =
      options.maximumFiles ?? defaultMaximumRepositorySymbolGraphFiles;
    this.maximumSymbols =
      options.maximumSymbols ?? defaultMaximumRepositorySymbolGraphSymbols;
    this.maximumReferences =
      options.maximumReferences ?? defaultMaximumRepositorySymbolGraphReferences;
    this.maximumEdges =
      options.maximumEdges ?? defaultMaximumRepositorySymbolGraphEdges;
    this.maximumLookupReferences =
      options.maximumLookupReferences ??
      defaultMaximumRepositorySymbolLookupReferences;
    assertPositiveInteger(this.maximumFiles, "maximumFiles");
    assertPositiveInteger(this.maximumSymbols, "maximumSymbols");
    assertPositiveInteger(this.maximumReferences, "maximumReferences");
    assertPositiveInteger(this.maximumEdges, "maximumEdges");
    assertPositiveInteger(
      this.maximumLookupReferences,
      "maximumLookupReferences",
    );
  }

  async getGraph(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositorySymbolGraphResult> {
    const scope = await this.loadScope(input);
    const graph = buildRepositorySymbolGraph(
      scope.files,
      scope.symbols,
      this.maximumEdges,
      this.maximumReferences,
    );
    return {
      repositoryId: scope.repository.id,
      branch: scope.repository.branch,
      commitSha: scope.repository.lastIndexedCommit,
      nodes: graph.nodes,
      edges: graph.edges,
      stats: graph.stats,
    };
  }

  async findReferences(input: {
    authenticatedUserId: string;
    repositoryId: string;
    symbol: string;
  }): Promise<RepositorySymbolReferenceResult> {
    const requestedSymbol = input.symbol.trim();
    if (!requestedSymbol || requestedSymbol.includes("\0")) {
      throw new RepositorySymbolGraphError(
        "INVALID_REQUEST",
        "Repository symbol reference request is invalid",
      );
    }
    const scope = await this.loadScope(input);
    const graph = buildRepositorySymbolGraph(
      scope.files,
      scope.symbols,
      this.maximumEdges,
      this.maximumReferences,
    );
    const definitions = graph.nodes.filter(
      (node) => node.name === requestedSymbol,
    );
    if (definitions.length === 0) {
      throw new RepositorySymbolGraphError(
        "SYMBOL_NOT_FOUND",
        "Symbol was not found in the indexed repository",
      );
    }
    const references = graph.nodes.filter((node) =>
      graph.referenceNamesByNodeId.get(node.id)?.has(requestedSymbol),
    );
    if (references.length > this.maximumLookupReferences) {
      throw new RepositorySymbolGraphError(
        "SYMBOL_GRAPH_TOO_LARGE",
        "The repository symbol reference result exceeds the configured limit",
      );
    }

    return {
      repositoryId: scope.repository.id,
      branch: scope.repository.branch,
      commitSha: scope.repository.lastIndexedCommit,
      symbol: requestedSymbol,
      ambiguous: definitions.length > 1,
      definitions,
      references,
      stats: {
        definitions: definitions.length,
        references: references.length,
        files: new Set(references.map((reference) => reference.filePath)).size,
      },
    };
  }

  private async loadScope(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<LoadedSymbolScope> {
    if (
      !objectIdPattern.test(input.authenticatedUserId) ||
      !objectIdPattern.test(input.repositoryId)
    ) {
      throw new RepositorySymbolGraphError(
        "INVALID_REQUEST",
        "Repository symbol graph request is invalid",
      );
    }

    let repository: RepositorySymbolGraphRecord | null;
    try {
      repository = await this.gateway.findOwnedRepository(input);
    } catch (error) {
      throw new RepositorySymbolGraphError(
        "REPOSITORY_ACCESS_FAILED",
        "The repository could not be accessed",
        { cause: error },
      );
    }
    if (repository === null) {
      throw new RepositorySymbolGraphError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
      );
    }
    if (repository.status !== "ready" || !repository.lastIndexedCommit) {
      throw new RepositorySymbolGraphError(
        "REPOSITORY_NOT_READY",
        "Repository indexing is not complete",
      );
    }
    const readyRepository = {
      ...repository,
      lastIndexedCommit: repository.lastIndexedCommit,
    };

    let files: RepositorySymbolGraphFile[];
    let symbols: RepositorySymbolGraphSymbol[];
    try {
      files = await this.gateway.listFiles({
        repositoryId: readyRepository.id,
        branch: readyRepository.branch,
        commitSha: readyRepository.lastIndexedCommit,
        limit: this.maximumFiles + 1,
      });
      if (files.length > this.maximumFiles) {
        throw new RepositorySymbolGraphError(
          "SYMBOL_GRAPH_TOO_LARGE",
          "The repository symbol graph exceeds the configured file limit",
        );
      }
      symbols = await this.gateway.listSymbols({
        repositoryId: readyRepository.id,
        fileIds: files.map((file) => file.id),
        limit: this.maximumSymbols + 1,
      });
    } catch (error) {
      if (error instanceof RepositorySymbolGraphError) {
        throw error;
      }
      throw new RepositorySymbolGraphError(
        "SYMBOL_DATA_UNAVAILABLE",
        "Repository symbol metadata could not be loaded",
        { cause: error },
      );
    }
    if (symbols.length > this.maximumSymbols) {
      throw new RepositorySymbolGraphError(
        "SYMBOL_GRAPH_TOO_LARGE",
        "The repository symbol graph exceeds the configured symbol limit",
      );
    }

    return { repository: readyRepository, files, symbols };
  }
}

export class MongooseRepositorySymbolGraphGateway
  implements RepositorySymbolGraphGateway
{
  async findOwnedRepository(input: {
    repositoryId: string;
    authenticatedUserId: string;
  }): Promise<RepositorySymbolGraphRecord | null> {
    const repository = await RepositoryModel.findOne({
      _id: new Types.ObjectId(input.repositoryId),
      userId: new Types.ObjectId(input.authenticatedUserId),
      githubAccessRevokedAt: trusted({ $exists: false }),
    })
      .select("selectedBranch status lastIndexedCommit")
      .lean()
      .exec();
    if (repository === null) {
      return null;
    }
    return {
      id: repository._id.toString(),
      branch: repository.selectedBranch,
      status: repository.status,
      ...(repository.lastIndexedCommit === undefined
        ? {}
        : { lastIndexedCommit: repository.lastIndexedCommit }),
    };
  }

  async listFiles(input: {
    repositoryId: string;
    branch: string;
    commitSha: string;
    limit: number;
  }): Promise<RepositorySymbolGraphFile[]> {
    const files = await RepositoryFileModel.find({
      repositoryId: new Types.ObjectId(input.repositoryId),
      branch: input.branch,
      commitSha: input.commitSha,
    })
      .select("path language")
      .sort({ path: 1 })
      .limit(input.limit)
      .lean()
      .exec();
    return files.map((file) => ({
      id: file._id.toString(),
      path: file.path,
      language: file.language,
    }));
  }

  async listSymbols(input: {
    repositoryId: string;
    fileIds: readonly string[];
    limit: number;
  }): Promise<RepositorySymbolGraphSymbol[]> {
    if (input.fileIds.length === 0) {
      return [];
    }
    const symbols = await SymbolModel.find({
      repositoryId: new Types.ObjectId(input.repositoryId),
      fileId: trusted({
        $in: input.fileIds.map((fileId) => new Types.ObjectId(fileId)),
      }),
    })
      .select("fileId name type startLine endLine references")
      .sort({ fileId: 1, startLine: 1, endLine: 1, name: 1 })
      .limit(input.limit)
      .lean()
      .exec();
    return symbols.map((symbol) => ({
      id: symbol._id.toString(),
      fileId: symbol.fileId.toString(),
      name: symbol.name,
      type: symbol.type,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      references: [...symbol.references],
    }));
  }
}

let defaultRepositorySymbolGraphService:
  | RepositorySymbolGraphService
  | undefined;

export function getDefaultRepositorySymbolGraphService(): RepositorySymbolGraphService {
  defaultRepositorySymbolGraphService ??= new RepositorySymbolGraphService(
    new MongooseRepositorySymbolGraphGateway(),
  );
  return defaultRepositorySymbolGraphService;
}
