import path from "node:path";

import {
  RepositoryApplicationFlowError,
  getDefaultRepositoryApplicationFlowService,
  type RepositoryApplicationFlowResult,
  type RepositoryApplicationFlowServiceContract,
} from "./repository-application-flow.service.js";
import {
  RepositoryImportGraphError,
  getDefaultRepositoryImportGraphService,
  type RepositoryImportGraphNode,
  type RepositoryImportGraphResult,
  type RepositoryImportGraphServiceContract,
} from "./repository-import-graph.service.js";
import {
  RepositorySymbolGraphError,
  getDefaultRepositorySymbolGraphService,
  type RepositorySymbolGraphResult,
  type RepositorySymbolGraphServiceContract,
} from "./repository-symbol-graph.service.js";

export const defaultDependencyExplorationDepth = 2;
export const maximumDependencyExplorationDepth = 4;
export const defaultMaximumDependencyExplorationNodes = 250;
export const defaultMaximumDependencyExplorationEdges = 500;
export const defaultRelatedFileSuggestionLimit = 10;
export const maximumRelatedFileSuggestionLimit = 50;

const objectIdPattern = /^[0-9a-f]{24}$/iu;

export type RepositoryDependencyDirection =
  | "imports"
  | "imported-by"
  | "both";

export type RepositoryDependencyRelation =
  | "origin"
  | "dependency"
  | "dependent"
  | "both";

export type RepositoryDependencyExplorationNode = RepositoryImportGraphNode & {
  distance: number;
  relation: RepositoryDependencyRelation;
};

export type RepositoryDependencyExplorationResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  origin: string;
  direction: RepositoryDependencyDirection;
  depth: number;
  nodes: RepositoryDependencyExplorationNode[];
  edges: RepositoryImportGraphResult["edges"];
  stats: {
    availableFiles: number;
    returnedFiles: number;
    returnedEdges: number;
    truncated: boolean;
  };
};

export type RelatedFileReasonCode =
  | "DIRECT_IMPORT"
  | "DIRECT_DEPENDENT"
  | "APPLICATION_FLOW"
  | "SYMBOL_REFERENCE"
  | "SAME_APPLICATION_FLOW"
  | "SECOND_DEGREE_IMPORT"
  | "SECOND_DEGREE_DEPENDENT"
  | "SHARED_DEPENDENCY";

export type RelatedFileReason = {
  code: RelatedFileReasonCode;
  description: string;
  score: number;
};

export type RelatedFileSuggestion = {
  filePath: string;
  language: string;
  score: number;
  reasons: RelatedFileReason[];
};

export type RepositoryRelatedFilesResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  origin: string;
  suggestions: RelatedFileSuggestion[];
  stats: {
    consideredFiles: number;
    matchingFiles: number;
    returnedFiles: number;
    truncated: boolean;
  };
};

export interface RepositoryDependencyExplorationServiceContract {
  exploreDependencies(input: {
    authenticatedUserId: string;
    repositoryId: string;
    filePath: string;
    direction?: RepositoryDependencyDirection;
    depth?: number;
  }): Promise<RepositoryDependencyExplorationResult>;
  suggestRelatedFiles(input: {
    authenticatedUserId: string;
    repositoryId: string;
    filePath: string;
    limit?: number;
  }): Promise<RepositoryRelatedFilesResult>;
}

export type RepositoryDependencyExplorationErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_NOT_READY"
  | "FILE_NOT_FOUND"
  | "DEPENDENCY_DATA_UNAVAILABLE"
  | "DEPENDENCY_DATA_INVALID"
  | "DEPENDENCY_TOO_LARGE";

export class RepositoryDependencyExplorationError extends Error {
  override readonly name = "RepositoryDependencyExplorationError";

  constructor(
    readonly code: RepositoryDependencyExplorationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type BuildRepositoryDependencyExplorationOptions = {
  maximumNodes?: number;
  maximumEdges?: number;
};

type RelatedFileGraphs = {
  importGraph: RepositoryImportGraphResult;
  symbolGraph: RepositorySymbolGraphResult;
  applicationFlow: RepositoryApplicationFlowResult;
};

type RepositoryDependencyExplorationDependencies = {
  importGraphService: RepositoryImportGraphServiceContract;
  symbolGraphService: RepositorySymbolGraphServiceContract;
  applicationFlowService: RepositoryApplicationFlowServiceContract;
};

type TraversalRelation = Exclude<RepositoryDependencyRelation, "origin">;

const relatedFileReasons: Record<RelatedFileReasonCode, RelatedFileReason> = {
  DIRECT_IMPORT: {
    code: "DIRECT_IMPORT",
    description: "The selected file imports this file directly.",
    score: 100,
  },
  DIRECT_DEPENDENT: {
    code: "DIRECT_DEPENDENT",
    description: "This file imports the selected file directly.",
    score: 95,
  },
  APPLICATION_FLOW: {
    code: "APPLICATION_FLOW",
    description: "This file is directly connected in an application flow.",
    score: 90,
  },
  SYMBOL_REFERENCE: {
    code: "SYMBOL_REFERENCE",
    description: "Symbols in these files reference one another.",
    score: 80,
  },
  SAME_APPLICATION_FLOW: {
    code: "SAME_APPLICATION_FLOW",
    description: "This file participates in the same discovered application flow.",
    score: 60,
  },
  SECOND_DEGREE_IMPORT: {
    code: "SECOND_DEGREE_IMPORT",
    description: "This file is reached through one intermediate import.",
    score: 40,
  },
  SECOND_DEGREE_DEPENDENT: {
    code: "SECOND_DEGREE_DEPENDENT",
    description: "This file depends on the selected file through one intermediate file.",
    score: 35,
  },
  SHARED_DEPENDENCY: {
    code: "SHARED_DEPENDENCY",
    description: "This file and the selected file import a common dependency.",
    score: 30,
  },
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizeFilePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_024 || trimmed.includes("\0")) {
    throw new RepositoryDependencyExplorationError(
      "INVALID_REQUEST",
      "Repository dependency exploration request is invalid",
    );
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new RepositoryDependencyExplorationError(
      "INVALID_REQUEST",
      "Repository dependency exploration request is invalid",
    );
  }
  return normalized;
}

function assertFileExists(
  graph: RepositoryImportGraphResult,
  filePath: string,
): RepositoryImportGraphNode {
  const node = graph.nodes.find((candidate) => candidate.path === filePath);
  if (node === undefined) {
    throw new RepositoryDependencyExplorationError(
      "FILE_NOT_FOUND",
      "File was not found in the indexed repository",
    );
  }
  return node;
}

function mergeRelation(
  current: RepositoryDependencyRelation | undefined,
  incoming: TraversalRelation,
): TraversalRelation {
  if (current === undefined || current === "origin") {
    return incoming;
  }
  if (current === incoming || current === "both") {
    return current;
  }
  return "both";
}

function compareTraversalNodes(
  left: RepositoryDependencyExplorationNode,
  right: RepositoryDependencyExplorationNode,
): number {
  return left.distance - right.distance || left.path.localeCompare(right.path);
}

export function buildRepositoryDependencyExploration(
  graph: RepositoryImportGraphResult,
  input: {
    filePath: string;
    direction: RepositoryDependencyDirection;
    depth: number;
  },
  options: BuildRepositoryDependencyExplorationOptions = {},
): RepositoryDependencyExplorationResult {
  const maximumNodes =
    options.maximumNodes ?? defaultMaximumDependencyExplorationNodes;
  const maximumEdges =
    options.maximumEdges ?? defaultMaximumDependencyExplorationEdges;
  assertPositiveInteger(maximumNodes, "maximumNodes");
  assertPositiveInteger(maximumEdges, "maximumEdges");
  if (
    !Number.isSafeInteger(input.depth) ||
    input.depth <= 0 ||
    input.depth > maximumDependencyExplorationDepth ||
    !["imports", "imported-by", "both"].includes(input.direction)
  ) {
    throw new RepositoryDependencyExplorationError(
      "INVALID_REQUEST",
      "Repository dependency exploration request is invalid",
    );
  }

  const requestedFilePath = normalizeFilePath(input.filePath);
  assertFileExists(graph, requestedFilePath);
  const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const outgoingTargets = outgoing.get(edge.source) ?? [];
    outgoingTargets.push(edge.target);
    outgoing.set(edge.source, outgoingTargets);
    const incomingSources = incoming.get(edge.target) ?? [];
    incomingSources.push(edge.source);
    incoming.set(edge.target, incomingSources);
  }
  for (const neighbours of [...outgoing.values(), ...incoming.values()]) {
    neighbours.sort((left, right) => left.localeCompare(right));
  }

  const distances = new Map([[requestedFilePath, 0]]);
  const relations = new Map<string, RepositoryDependencyRelation>([
    [requestedFilePath, "origin"],
  ]);
  let frontier: Array<{
    filePath: string;
    relation?: TraversalRelation;
  }> = [{ filePath: requestedFilePath }];
  let truncated = false;
  for (let distance = 1; distance <= input.depth; distance += 1) {
    const nextFrontier = new Map<string, TraversalRelation>();
    for (const current of frontier.sort((left, right) =>
      left.filePath.localeCompare(right.filePath),
    )) {
      const neighbours: Array<{
        filePath: string;
        relation: TraversalRelation;
      }> = [];
      if (input.direction !== "imported-by") {
        for (const candidate of outgoing.get(current.filePath) ?? []) {
          neighbours.push({
            filePath: candidate,
            relation: current.relation ?? "dependency",
          });
        }
      }
      if (input.direction !== "imports") {
        for (const candidate of incoming.get(current.filePath) ?? []) {
          neighbours.push({
            filePath: candidate,
            relation: current.relation ?? "dependent",
          });
        }
      }
      neighbours.sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) ||
          left.relation.localeCompare(right.relation),
      );

      for (const neighbour of neighbours) {
        if (!nodesByPath.has(neighbour.filePath)) {
          continue;
        }
        const existingDistance = distances.get(neighbour.filePath);
        if (existingDistance === undefined) {
          if (distances.size >= maximumNodes) {
            truncated = true;
            continue;
          }
          distances.set(neighbour.filePath, distance);
          relations.set(neighbour.filePath, neighbour.relation);
          nextFrontier.set(neighbour.filePath, neighbour.relation);
        } else if (existingDistance === distance) {
          const relation = mergeRelation(
            relations.get(neighbour.filePath),
            neighbour.relation,
          );
          relations.set(neighbour.filePath, relation);
          nextFrontier.set(neighbour.filePath, relation);
        } else if (
          existingDistance < distance &&
          neighbour.filePath !== requestedFilePath
        ) {
          relations.set(
            neighbour.filePath,
            mergeRelation(relations.get(neighbour.filePath), neighbour.relation),
          );
        }
      }
    }
    frontier = [...nextFrontier].map(([filePath, relation]) => ({
      filePath,
      relation,
    }));
    if (frontier.length === 0) {
      break;
    }
  }

  const selectedPaths = new Set(distances.keys());
  const candidateEdges = graph.edges.filter(
    (edge) => selectedPaths.has(edge.source) && selectedPaths.has(edge.target),
  );
  const edges = candidateEdges.slice(0, maximumEdges);
  if (edges.length < candidateEdges.length) {
    truncated = true;
  }
  const nodes = [...selectedPaths]
    .map((filePath): RepositoryDependencyExplorationNode => ({
      ...nodesByPath.get(filePath)!,
      distance: distances.get(filePath)!,
      relation: relations.get(filePath) ?? "both",
    }))
    .sort(compareTraversalNodes);

  return {
    repositoryId: graph.repositoryId,
    branch: graph.branch,
    commitSha: graph.commitSha,
    origin: requestedFilePath,
    direction: input.direction,
    depth: input.depth,
    nodes,
    edges,
    stats: {
      availableFiles: graph.nodes.length,
      returnedFiles: nodes.length,
      returnedEdges: edges.length,
      truncated,
    },
  };
}

function sameScope(graphs: RelatedFileGraphs): boolean {
  return [graphs.symbolGraph, graphs.applicationFlow].every(
    (graph) =>
      graph.repositoryId === graphs.importGraph.repositoryId &&
      graph.branch === graphs.importGraph.branch &&
      graph.commitSha === graphs.importGraph.commitSha,
  );
}

function addReason(
  reasonsByFile: Map<string, Map<RelatedFileReasonCode, RelatedFileReason>>,
  availableFiles: ReadonlySet<string>,
  origin: string,
  filePath: string,
  code: RelatedFileReasonCode,
): void {
  if (filePath === origin || !availableFiles.has(filePath)) {
    return;
  }
  const reasons = reasonsByFile.get(filePath) ?? new Map();
  reasons.set(code, relatedFileReasons[code]);
  reasonsByFile.set(filePath, reasons);
}

export function buildRepositoryRelatedFileSuggestions(
  graphs: RelatedFileGraphs,
  filePath: string,
  limit = defaultRelatedFileSuggestionLimit,
): RepositoryRelatedFilesResult {
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > maximumRelatedFileSuggestionLimit
  ) {
    throw new RepositoryDependencyExplorationError(
      "INVALID_REQUEST",
      "Related file suggestion request is invalid",
    );
  }
  if (!sameScope(graphs)) {
    throw new RepositoryDependencyExplorationError(
      "DEPENDENCY_DATA_INVALID",
      "Repository relationship sources do not describe the same indexed commit",
    );
  }
  const origin = normalizeFilePath(filePath);
  assertFileExists(graphs.importGraph, origin);
  const filesByPath = new Map(
    graphs.importGraph.nodes.map((node) => [node.path, node]),
  );
  const availableFiles = new Set(filesByPath.keys());
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of graphs.importGraph.edges) {
    const targets = outgoing.get(edge.source) ?? new Set();
    targets.add(edge.target);
    outgoing.set(edge.source, targets);
    const sources = incoming.get(edge.target) ?? new Set();
    sources.add(edge.source);
    incoming.set(edge.target, sources);
  }

  const reasonsByFile = new Map<
    string,
    Map<RelatedFileReasonCode, RelatedFileReason>
  >();
  const directImports = outgoing.get(origin) ?? new Set<string>();
  const directDependents = incoming.get(origin) ?? new Set<string>();
  for (const candidate of directImports) {
    addReason(reasonsByFile, availableFiles, origin, candidate, "DIRECT_IMPORT");
    for (const secondDegree of outgoing.get(candidate) ?? []) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        secondDegree,
        "SECOND_DEGREE_IMPORT",
      );
    }
  }
  for (const candidate of directDependents) {
    addReason(
      reasonsByFile,
      availableFiles,
      origin,
      candidate,
      "DIRECT_DEPENDENT",
    );
    for (const secondDegree of incoming.get(candidate) ?? []) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        secondDegree,
        "SECOND_DEGREE_DEPENDENT",
      );
    }
  }
  for (const candidate of availableFiles) {
    if (candidate === origin) {
      continue;
    }
    const candidateImports = outgoing.get(candidate) ?? new Set<string>();
    if ([...candidateImports].some((dependency) => directImports.has(dependency))) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        candidate,
        "SHARED_DEPENDENCY",
      );
    }
  }

  const symbolFilesById = new Map(
    graphs.symbolGraph.nodes.map((node) => [node.id, node.filePath]),
  );
  for (const edge of graphs.symbolGraph.edges) {
    const source = symbolFilesById.get(edge.source);
    const target = symbolFilesById.get(edge.target);
    if (source === origin && target !== undefined) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        target,
        "SYMBOL_REFERENCE",
      );
    } else if (target === origin && source !== undefined) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        source,
        "SYMBOL_REFERENCE",
      );
    }
  }

  const flowFilesById = new Map(
    graphs.applicationFlow.nodes.map((node) => [node.id, node.filePath]),
  );
  for (const edge of graphs.applicationFlow.edges) {
    const source = flowFilesById.get(edge.source);
    const target = flowFilesById.get(edge.target);
    if (source === origin && target !== undefined) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        target,
        "APPLICATION_FLOW",
      );
    } else if (target === origin && source !== undefined) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        source,
        "APPLICATION_FLOW",
      );
    }
  }
  for (const flow of graphs.applicationFlow.flows) {
    const flowFiles = new Set(
      flow.nodeIds
        .map((nodeId) => flowFilesById.get(nodeId))
        .filter((candidate): candidate is string => candidate !== undefined),
    );
    if (!flowFiles.has(origin)) {
      continue;
    }
    for (const candidate of flowFiles) {
      addReason(
        reasonsByFile,
        availableFiles,
        origin,
        candidate,
        "SAME_APPLICATION_FLOW",
      );
    }
  }

  const ranked = [...reasonsByFile]
    .map(([candidatePath, reasonsMap]): RelatedFileSuggestion => {
      const reasons = [...reasonsMap.values()].sort(
        (left, right) =>
          right.score - left.score || left.code.localeCompare(right.code),
      );
      return {
        filePath: candidatePath,
        language: filesByPath.get(candidatePath)!.language,
        score: reasons.reduce((total, reason) => total + reason.score, 0),
        reasons,
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.reasons.length - left.reasons.length ||
        left.filePath.localeCompare(right.filePath),
    );
  const suggestions = ranked.slice(0, limit);

  return {
    repositoryId: graphs.importGraph.repositoryId,
    branch: graphs.importGraph.branch,
    commitSha: graphs.importGraph.commitSha,
    origin,
    suggestions,
    stats: {
      consideredFiles: Math.max(0, graphs.importGraph.nodes.length - 1),
      matchingFiles: ranked.length,
      returnedFiles: suggestions.length,
      truncated: suggestions.length < ranked.length,
    },
  };
}

function mapSourceError(error: unknown): RepositoryDependencyExplorationError {
  if (
    error instanceof RepositoryImportGraphError ||
    error instanceof RepositorySymbolGraphError ||
    error instanceof RepositoryApplicationFlowError
  ) {
    if (error.code === "INVALID_REQUEST") {
      return new RepositoryDependencyExplorationError(
        "INVALID_REQUEST",
        "Repository dependency exploration request is invalid",
        { cause: error },
      );
    }
    if (error.code === "REPOSITORY_NOT_FOUND") {
      return new RepositoryDependencyExplorationError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
        { cause: error },
      );
    }
    if (error.code === "REPOSITORY_NOT_READY") {
      return new RepositoryDependencyExplorationError(
        "REPOSITORY_NOT_READY",
        "Repository indexing is not complete",
        { cause: error },
      );
    }
    if (
      error.code === "GRAPH_TOO_LARGE" ||
      error.code === "SYMBOL_GRAPH_TOO_LARGE" ||
      error.code === "FLOW_TOO_LARGE"
    ) {
      return new RepositoryDependencyExplorationError(
        "DEPENDENCY_TOO_LARGE",
        "Repository dependency data exceeds a configured safety limit",
        { cause: error },
      );
    }
    if (
      error.code === "GRAPH_DATA_INVALID" ||
      error.code === "SYMBOL_DATA_INVALID" ||
      error.code === "FLOW_DATA_INVALID"
    ) {
      return new RepositoryDependencyExplorationError(
        "DEPENDENCY_DATA_INVALID",
        "Indexed repository relationship metadata is invalid",
        { cause: error },
      );
    }
  }
  return new RepositoryDependencyExplorationError(
    "DEPENDENCY_DATA_UNAVAILABLE",
    "Repository dependency metadata could not be loaded",
    { cause: error },
  );
}

export class RepositoryDependencyExplorationService
  implements RepositoryDependencyExplorationServiceContract
{
  private readonly maximumNodes: number;
  private readonly maximumEdges: number;

  constructor(
    private readonly dependencies: RepositoryDependencyExplorationDependencies,
    options: BuildRepositoryDependencyExplorationOptions = {},
  ) {
    this.maximumNodes =
      options.maximumNodes ?? defaultMaximumDependencyExplorationNodes;
    this.maximumEdges =
      options.maximumEdges ?? defaultMaximumDependencyExplorationEdges;
    assertPositiveInteger(this.maximumNodes, "maximumNodes");
    assertPositiveInteger(this.maximumEdges, "maximumEdges");
  }

  async exploreDependencies(input: {
    authenticatedUserId: string;
    repositoryId: string;
    filePath: string;
    direction?: RepositoryDependencyDirection;
    depth?: number;
  }): Promise<RepositoryDependencyExplorationResult> {
    const normalized = this.validateBaseInput(input);
    const direction = input.direction ?? "both";
    const depth = input.depth ?? defaultDependencyExplorationDepth;
    if (
      !["imports", "imported-by", "both"].includes(direction) ||
      !Number.isSafeInteger(depth) ||
      depth <= 0 ||
      depth > maximumDependencyExplorationDepth
    ) {
      throw new RepositoryDependencyExplorationError(
        "INVALID_REQUEST",
        "Repository dependency exploration request is invalid",
      );
    }

    let graph: RepositoryImportGraphResult;
    try {
      graph = await this.dependencies.importGraphService.getGraph({
        authenticatedUserId: input.authenticatedUserId,
        repositoryId: input.repositoryId,
      });
    } catch (error) {
      throw mapSourceError(error);
    }
    return buildRepositoryDependencyExploration(
      graph,
      { filePath: normalized, direction, depth },
      { maximumNodes: this.maximumNodes, maximumEdges: this.maximumEdges },
    );
  }

  async suggestRelatedFiles(input: {
    authenticatedUserId: string;
    repositoryId: string;
    filePath: string;
    limit?: number;
  }): Promise<RepositoryRelatedFilesResult> {
    const normalized = this.validateBaseInput(input);
    const limit = input.limit ?? defaultRelatedFileSuggestionLimit;
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > maximumRelatedFileSuggestionLimit
    ) {
      throw new RepositoryDependencyExplorationError(
        "INVALID_REQUEST",
        "Related file suggestion request is invalid",
      );
    }

    let graphs: RelatedFileGraphs;
    const scope = {
      authenticatedUserId: input.authenticatedUserId,
      repositoryId: input.repositoryId,
    };
    try {
      const [importGraph, symbolGraph, applicationFlow] = await Promise.all([
        this.dependencies.importGraphService.getGraph(scope),
        this.dependencies.symbolGraphService.getGraph(scope),
        this.dependencies.applicationFlowService.getFlow(scope),
      ]);
      graphs = { importGraph, symbolGraph, applicationFlow };
    } catch (error) {
      throw mapSourceError(error);
    }
    return buildRepositoryRelatedFileSuggestions(graphs, normalized, limit);
  }

  private validateBaseInput(input: {
    authenticatedUserId: string;
    repositoryId: string;
    filePath: string;
  }): string {
    if (
      !objectIdPattern.test(input.authenticatedUserId) ||
      !objectIdPattern.test(input.repositoryId)
    ) {
      throw new RepositoryDependencyExplorationError(
        "INVALID_REQUEST",
        "Repository dependency exploration request is invalid",
      );
    }
    return normalizeFilePath(input.filePath);
  }
}

let defaultRepositoryDependencyExplorationService:
  | RepositoryDependencyExplorationService
  | undefined;

export function getDefaultRepositoryDependencyExplorationService(): RepositoryDependencyExplorationService {
  defaultRepositoryDependencyExplorationService ??=
    new RepositoryDependencyExplorationService({
      importGraphService: getDefaultRepositoryImportGraphService(),
      symbolGraphService: getDefaultRepositorySymbolGraphService(),
      applicationFlowService: getDefaultRepositoryApplicationFlowService(),
    });
  return defaultRepositoryDependencyExplorationService;
}
