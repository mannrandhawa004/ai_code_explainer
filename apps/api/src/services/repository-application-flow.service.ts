import {
  MongooseRepositorySymbolGraphGateway,
  type RepositorySymbolGraphFile,
  type RepositorySymbolGraphGateway,
  type RepositorySymbolGraphRecord,
  type RepositorySymbolGraphSymbol,
} from "./repository-symbol-graph.service.js";

export const defaultMaximumApplicationFlowFiles = 5_000;
export const defaultMaximumApplicationFlowSymbols = 10_000;
export const defaultMaximumApplicationFlowReferences = 100_000;
export const defaultMaximumApplicationFlowEdges = 50_000;
export const defaultMaximumApplicationFlows = 1_000;

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const layerOrder = {
  route: 0,
  controller: 1,
  service: 2,
  model: 3,
} as const;
const callableRouteHandlerTypes = new Set([
  "function",
  "arrow_function",
  "method",
  "controller",
]);

export type ApplicationFlowLayer = keyof typeof layerOrder;

export type RepositoryApplicationFlowNode = {
  id: string;
  name: string;
  layer: ApplicationFlowLayer;
  symbolType: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  outgoing: number;
  incoming: number;
};

export type RepositoryApplicationFlowEdge = {
  source: string;
  target: string;
  reference: string;
  ambiguous: boolean;
};

export type RepositoryApplicationFlowPath = {
  routeNodeId: string;
  nodeIds: string[];
  complete: boolean;
  stopsAt: ApplicationFlowLayer;
};

export type RepositoryApplicationFlowStats = {
  routes: number;
  controllers: number;
  services: number;
  models: number;
  edges: number;
  flows: number;
  completeFlows: number;
  ambiguousReferences: number;
  inspectedReferenceNames: number;
  flowsTruncated: boolean;
};

export type RepositoryApplicationFlowResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  route?: string;
  nodes: RepositoryApplicationFlowNode[];
  edges: RepositoryApplicationFlowEdge[];
  flows: RepositoryApplicationFlowPath[];
  stats: RepositoryApplicationFlowStats;
};

export interface RepositoryApplicationFlowServiceContract {
  getFlow(input: {
    authenticatedUserId: string;
    repositoryId: string;
    route?: string;
  }): Promise<RepositoryApplicationFlowResult>;
}

export type RepositoryApplicationFlowErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_NOT_READY"
  | "REPOSITORY_ACCESS_FAILED"
  | "FLOW_DATA_UNAVAILABLE"
  | "FLOW_DATA_INVALID"
  | "FLOW_TOO_LARGE"
  | "ROUTE_NOT_FOUND";

export class RepositoryApplicationFlowError extends Error {
  override readonly name = "RepositoryApplicationFlowError";

  constructor(
    readonly code: RepositoryApplicationFlowErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type BuildRepositoryApplicationFlowOptions = {
  route?: string;
  maximumReferences?: number;
  maximumEdges?: number;
  maximumFlows?: number;
};

type PreparedSymbol = Omit<RepositorySymbolGraphSymbol, "references"> & {
  file: RepositorySymbolGraphFile;
  name: string;
  type: string;
  references: ReadonlySet<string>;
};

type FlowGraph = Pick<
  RepositoryApplicationFlowResult,
  "route" | "nodes" | "edges" | "flows" | "stats"
>;

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function safeString(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new RepositoryApplicationFlowError(
      "FLOW_DATA_INVALID",
      "Indexed application flow metadata is invalid",
    );
  }
  return normalized;
}

function pathLayer(filePath: string): Exclude<ApplicationFlowLayer, "route"> | undefined {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (
    /(?:^|\/)controllers?(?:\/|$)|(?:^|[.-])controller(?:[.-]|$)/u.test(
      normalized,
    )
  ) {
    return "controller";
  }
  if (
    /(?:^|\/)services?(?:\/|$)|(?:^|[.-])service(?:[.-]|$)/u.test(
      normalized,
    )
  ) {
    return "service";
  }
  if (
    /(?:^|\/)models?(?:\/|$)|(?:^|[.-])(?:model|schema)(?:[.-]|$)/u.test(
      normalized,
    )
  ) {
    return "model";
  }
  return undefined;
}

export function inferApplicationFlowLayer(
  symbol: Pick<RepositorySymbolGraphSymbol, "type">,
  filePath: string,
): ApplicationFlowLayer | undefined {
  switch (symbol.type) {
    case "express_route":
      return "route";
    case "controller":
      return "controller";
    case "service":
      return "service";
    case "model":
      return "model";
    default:
      return pathLayer(filePath);
  }
}

function compareNodes(
  left: RepositoryApplicationFlowNode,
  right: RepositoryApplicationFlowNode,
): number {
  return (
    layerOrder[left.layer] - layerOrder[right.layer] ||
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function allowedTransition(
  source: ApplicationFlowLayer,
  target: ApplicationFlowLayer,
): boolean {
  return layerOrder[source] < layerOrder[target];
}

function enumerateFlows(
  roots: readonly RepositoryApplicationFlowNode[],
  nodesById: ReadonlyMap<string, RepositoryApplicationFlowNode>,
  edges: readonly RepositoryApplicationFlowEdge[],
  maximumFlows: number,
): { flows: RepositoryApplicationFlowPath[]; truncated: boolean } {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  for (const targets of adjacency.values()) {
    targets.sort((left, right) =>
      compareNodes(nodesById.get(left)!, nodesById.get(right)!),
    );
  }

  const flows: RepositoryApplicationFlowPath[] = [];
  for (const root of roots) {
    const stack: string[][] = [[root.id]];
    while (stack.length > 0) {
      const path = stack.pop()!;
      const lastId = path[path.length - 1]!;
      const lastNode = nodesById.get(lastId)!;
      const targets = adjacency.get(lastId) ?? [];
      if (lastNode.layer === "model" || targets.length === 0) {
        if (flows.length >= maximumFlows) {
          return { flows, truncated: true };
        }
        flows.push({
          routeNodeId: root.id,
          nodeIds: path,
          complete: lastNode.layer === "model",
          stopsAt: lastNode.layer,
        });
        continue;
      }
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        stack.push([...path, targets[index]!]);
      }
    }
  }
  return { flows, truncated: false };
}

function withDegrees(
  nodes: readonly RepositoryApplicationFlowNode[],
  edges: readonly RepositoryApplicationFlowEdge[],
): RepositoryApplicationFlowNode[] {
  const outgoing = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  return nodes
    .map((node) => ({
      ...node,
      outgoing: outgoing.get(node.id) ?? 0,
      incoming: incoming.get(node.id) ?? 0,
    }))
    .sort(compareNodes);
}

export function buildRepositoryApplicationFlow(
  files: readonly RepositorySymbolGraphFile[],
  symbols: readonly RepositorySymbolGraphSymbol[],
  options: BuildRepositoryApplicationFlowOptions = {},
): FlowGraph {
  const maximumReferences =
    options.maximumReferences ?? defaultMaximumApplicationFlowReferences;
  const maximumEdges =
    options.maximumEdges ?? defaultMaximumApplicationFlowEdges;
  const maximumFlows =
    options.maximumFlows ?? defaultMaximumApplicationFlows;
  assertPositiveInteger(maximumReferences, "maximumReferences");
  assertPositiveInteger(maximumEdges, "maximumEdges");
  assertPositiveInteger(maximumFlows, "maximumFlows");

  const requestedRoute = options.route?.trim();
  if (
    options.route !== undefined &&
    (!requestedRoute || requestedRoute.includes("\0"))
  ) {
    throw new RepositoryApplicationFlowError(
      "INVALID_REQUEST",
      "Repository application flow request is invalid",
    );
  }

  const filesById = new Map<string, RepositorySymbolGraphFile>();
  for (const file of files) {
    const id = safeString(file.id);
    if (filesById.has(id)) {
      throw new RepositoryApplicationFlowError(
        "FLOW_DATA_INVALID",
        "Indexed application flow metadata is invalid",
      );
    }
    filesById.set(id, {
      id,
      path: safeString(file.path),
      language: safeString(file.language),
    });
  }

  const prepared: PreparedSymbol[] = [];
  const preparedById = new Map<string, PreparedSymbol>();
  const symbolsByName = new Map<string, PreparedSymbol[]>();
  for (const symbol of symbols) {
    const id = safeString(symbol.id);
    const file = filesById.get(safeString(symbol.fileId));
    if (
      file === undefined ||
      preparedById.has(id) ||
      !Number.isSafeInteger(symbol.startLine) ||
      symbol.startLine <= 0 ||
      !Number.isSafeInteger(symbol.endLine) ||
      symbol.endLine < symbol.startLine
    ) {
      throw new RepositoryApplicationFlowError(
        "FLOW_DATA_INVALID",
        "Indexed application flow metadata is invalid",
      );
    }
    const item: PreparedSymbol = {
      ...symbol,
      id,
      fileId: file.id,
      file,
      name: safeString(symbol.name),
      type: safeString(symbol.type),
      references: new Set(symbol.references.map(safeString)),
    };
    prepared.push(item);
    preparedById.set(id, item);
    const named = symbolsByName.get(item.name) ?? [];
    named.push(item);
    symbolsByName.set(item.name, named);
  }

  const roles = new Map<string, ApplicationFlowLayer>();
  for (const symbol of prepared) {
    const role = inferApplicationFlowLayer(symbol, symbol.file.path);
    if (role !== undefined) {
      roles.set(symbol.id, role);
    }
  }
  for (const routeSymbol of prepared.filter(
    (symbol) => roles.get(symbol.id) === "route",
  )) {
    for (const reference of routeSymbol.references) {
      for (const target of symbolsByName.get(reference) ?? []) {
        if (
          !roles.has(target.id) &&
          callableRouteHandlerTypes.has(target.type)
        ) {
          roles.set(target.id, "controller");
        }
      }
    }
  }

  const allNodes = prepared
    .filter((symbol) => roles.has(symbol.id))
    .map((symbol): RepositoryApplicationFlowNode => ({
      id: symbol.id,
      name: symbol.name,
      layer: roles.get(symbol.id)!,
      symbolType: symbol.type,
      filePath: symbol.file.path,
      language: symbol.file.language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      outgoing: 0,
      incoming: 0,
    }))
    .sort(compareNodes);
  const flowDefinitionsByName = new Map<string, RepositoryApplicationFlowNode[]>();
  for (const node of allNodes) {
    const definitions = flowDefinitionsByName.get(node.name) ?? [];
    definitions.push(node);
    flowDefinitionsByName.set(node.name, definitions);
  }

  let inspectedReferenceNames = 0;
  const allEdges: RepositoryApplicationFlowEdge[] = [];
  const seenEdges = new Set<string>();
  for (const sourceNode of allNodes) {
    const source = preparedById.get(sourceNode.id)!;
    for (const reference of [...source.references].sort((left, right) =>
      left.localeCompare(right),
    )) {
      inspectedReferenceNames += 1;
      if (inspectedReferenceNames > maximumReferences) {
        throw new RepositoryApplicationFlowError(
          "FLOW_TOO_LARGE",
          "The repository application flow exceeds the reference limit",
        );
      }
      const targets = (flowDefinitionsByName.get(reference) ?? []).filter(
        (target) => allowedTransition(sourceNode.layer, target.layer),
      );
      const ambiguous = targets.length > 1;
      for (const target of targets) {
        const key = `${sourceNode.id}\0${target.id}`;
        if (seenEdges.has(key)) {
          continue;
        }
        if (allEdges.length >= maximumEdges) {
          throw new RepositoryApplicationFlowError(
            "FLOW_TOO_LARGE",
            "The repository application flow exceeds the edge limit",
          );
        }
        seenEdges.add(key);
        allEdges.push({
          source: sourceNode.id,
          target: target.id,
          reference,
          ambiguous,
        });
      }
    }
  }

  const selectedRoots = allNodes.filter(
    (node) =>
      node.layer === "route" &&
      (requestedRoute === undefined || node.name === requestedRoute),
  );
  if (requestedRoute !== undefined && selectedRoots.length === 0) {
    throw new RepositoryApplicationFlowError(
      "ROUTE_NOT_FOUND",
      "Route was not found in the indexed repository",
    );
  }

  let selectedNodeIds: Set<string>;
  if (requestedRoute === undefined) {
    selectedNodeIds = new Set(allNodes.map((node) => node.id));
  } else {
    const adjacency = new Map<string, string[]>();
    for (const edge of allEdges) {
      const targets = adjacency.get(edge.source) ?? [];
      targets.push(edge.target);
      adjacency.set(edge.source, targets);
    }
    selectedNodeIds = new Set(selectedRoots.map((root) => root.id));
    const stack = [...selectedNodeIds];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const target of adjacency.get(current) ?? []) {
        if (!selectedNodeIds.has(target)) {
          selectedNodeIds.add(target);
          stack.push(target);
        }
      }
    }
  }

  const selectedEdges = allEdges
    .filter(
      (edge) =>
        selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target),
    )
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        left.reference.localeCompare(right.reference),
    );
  const selectedNodes = withDegrees(
    allNodes.filter((node) => selectedNodeIds.has(node.id)),
    selectedEdges,
  );
  const selectedNodesById = new Map(selectedNodes.map((node) => [node.id, node]));
  const enumerated = enumerateFlows(
    selectedRoots,
    selectedNodesById,
    selectedEdges,
    maximumFlows,
  );
  const ambiguousReferences = new Set(
    selectedEdges
      .filter((edge) => edge.ambiguous)
      .map((edge) => `${edge.source}\0${edge.reference}`),
  ).size;

  return {
    ...(requestedRoute === undefined ? {} : { route: requestedRoute }),
    nodes: selectedNodes,
    edges: selectedEdges,
    flows: enumerated.flows,
    stats: {
      routes: selectedNodes.filter((node) => node.layer === "route").length,
      controllers: selectedNodes.filter((node) => node.layer === "controller")
        .length,
      services: selectedNodes.filter((node) => node.layer === "service").length,
      models: selectedNodes.filter((node) => node.layer === "model").length,
      edges: selectedEdges.length,
      flows: enumerated.flows.length,
      completeFlows: enumerated.flows.filter((flow) => flow.complete).length,
      ambiguousReferences,
      inspectedReferenceNames,
      flowsTruncated: enumerated.truncated,
    },
  };
}

export class RepositoryApplicationFlowService
  implements RepositoryApplicationFlowServiceContract
{
  private readonly maximumFiles: number;
  private readonly maximumSymbols: number;
  private readonly maximumReferences: number;
  private readonly maximumEdges: number;
  private readonly maximumFlows: number;

  constructor(
    private readonly gateway: RepositorySymbolGraphGateway,
    options: {
      maximumFiles?: number;
      maximumSymbols?: number;
      maximumReferences?: number;
      maximumEdges?: number;
      maximumFlows?: number;
    } = {},
  ) {
    this.maximumFiles =
      options.maximumFiles ?? defaultMaximumApplicationFlowFiles;
    this.maximumSymbols =
      options.maximumSymbols ?? defaultMaximumApplicationFlowSymbols;
    this.maximumReferences =
      options.maximumReferences ?? defaultMaximumApplicationFlowReferences;
    this.maximumEdges =
      options.maximumEdges ?? defaultMaximumApplicationFlowEdges;
    this.maximumFlows =
      options.maximumFlows ?? defaultMaximumApplicationFlows;
    assertPositiveInteger(this.maximumFiles, "maximumFiles");
    assertPositiveInteger(this.maximumSymbols, "maximumSymbols");
    assertPositiveInteger(this.maximumReferences, "maximumReferences");
    assertPositiveInteger(this.maximumEdges, "maximumEdges");
    assertPositiveInteger(this.maximumFlows, "maximumFlows");
  }

  async getFlow(input: {
    authenticatedUserId: string;
    repositoryId: string;
    route?: string;
  }): Promise<RepositoryApplicationFlowResult> {
    if (
      !objectIdPattern.test(input.authenticatedUserId) ||
      !objectIdPattern.test(input.repositoryId) ||
      (input.route !== undefined &&
        (!input.route.trim() || input.route.includes("\0")))
    ) {
      throw new RepositoryApplicationFlowError(
        "INVALID_REQUEST",
        "Repository application flow request is invalid",
      );
    }

    let repository: RepositorySymbolGraphRecord | null;
    try {
      repository = await this.gateway.findOwnedRepository(input);
    } catch (error) {
      throw new RepositoryApplicationFlowError(
        "REPOSITORY_ACCESS_FAILED",
        "The repository could not be accessed",
        { cause: error },
      );
    }
    if (repository === null) {
      throw new RepositoryApplicationFlowError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
      );
    }
    if (repository.status !== "ready" || !repository.lastIndexedCommit) {
      throw new RepositoryApplicationFlowError(
        "REPOSITORY_NOT_READY",
        "Repository indexing is not complete",
      );
    }

    let files: RepositorySymbolGraphFile[];
    let symbols: RepositorySymbolGraphSymbol[];
    try {
      files = await this.gateway.listFiles({
        repositoryId: repository.id,
        branch: repository.branch,
        commitSha: repository.lastIndexedCommit,
        limit: this.maximumFiles + 1,
      });
      if (files.length > this.maximumFiles) {
        throw new RepositoryApplicationFlowError(
          "FLOW_TOO_LARGE",
          "The repository application flow exceeds the file limit",
        );
      }
      symbols = await this.gateway.listSymbols({
        repositoryId: repository.id,
        fileIds: files.map((file) => file.id),
        limit: this.maximumSymbols + 1,
      });
    } catch (error) {
      if (error instanceof RepositoryApplicationFlowError) {
        throw error;
      }
      throw new RepositoryApplicationFlowError(
        "FLOW_DATA_UNAVAILABLE",
        "Repository application flow metadata could not be loaded",
        { cause: error },
      );
    }
    if (symbols.length > this.maximumSymbols) {
      throw new RepositoryApplicationFlowError(
        "FLOW_TOO_LARGE",
        "The repository application flow exceeds the symbol limit",
      );
    }

    const graph = buildRepositoryApplicationFlow(files, symbols, {
      ...(input.route === undefined ? {} : { route: input.route.trim() }),
      maximumReferences: this.maximumReferences,
      maximumEdges: this.maximumEdges,
      maximumFlows: this.maximumFlows,
    });
    return {
      repositoryId: repository.id,
      branch: repository.branch,
      commitSha: repository.lastIndexedCommit,
      ...graph,
    };
  }
}

let defaultRepositoryApplicationFlowService:
  | RepositoryApplicationFlowService
  | undefined;

export function getDefaultRepositoryApplicationFlowService(): RepositoryApplicationFlowService {
  defaultRepositoryApplicationFlowService ??=
    new RepositoryApplicationFlowService(
      new MongooseRepositorySymbolGraphGateway(),
    );
  return defaultRepositoryApplicationFlowService;
}
