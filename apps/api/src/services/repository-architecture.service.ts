import {
  RepositoryApplicationFlowError,
  getDefaultRepositoryApplicationFlowService,
  type ApplicationFlowLayer,
  type RepositoryApplicationFlowResult,
  type RepositoryApplicationFlowServiceContract,
} from "./repository-application-flow.service.js";
import {
  RepositoryImportGraphError,
  getDefaultRepositoryImportGraphService,
  type RepositoryImportGraphResult,
  type RepositoryImportGraphServiceContract,
} from "./repository-import-graph.service.js";
import {
  RepositorySymbolGraphError,
  getDefaultRepositorySymbolGraphService,
  type RepositorySymbolGraphResult,
  type RepositorySymbolGraphServiceContract,
} from "./repository-symbol-graph.service.js";

export const defaultMaximumArchitectureDiagramNodes = 100;
export const defaultMaximumArchitectureDiagramEdges = 200;
export const defaultMaximumArchitectureEntryPoints = 25;
export const defaultMaximumArchitectureHubs = 10;

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const maximumMermaidLabelLength = 180;
const layerOrder: Record<ApplicationFlowLayer, number> = {
  route: 0,
  controller: 1,
  service: 2,
  model: 3,
};

export type RepositoryArchitectureRiskSeverity = "info" | "warning";

export type RepositoryArchitectureRisk = {
  code:
    | "UNRESOLVED_IMPORTS"
    | "IMPORT_CYCLES"
    | "AMBIGUOUS_REFERENCES"
    | "INCOMPLETE_APPLICATION_FLOWS"
    | "TRUNCATED_FLOW_ENUMERATION"
    | "TRUNCATED_DIAGRAMS";
  severity: RepositoryArchitectureRiskSeverity;
  message: string;
  count: number;
};

export type RepositoryArchitectureDiagram = {
  mermaid: string;
  nodes: number;
  edges: number;
  truncated: boolean;
};

export type RepositoryArchitectureSummary = {
  overview: string;
  metrics: {
    files: number;
    languages: number;
    internalImports: number;
    importCycles: number;
    symbols: number;
    resolvedReferences: number;
    routes: number;
    controllers: number;
    services: number;
    models: number;
    completeFlows: number;
    incompleteFlows: number;
  };
  languages: Array<{
    name: string;
    files: number;
  }>;
  entryPoints: Array<{
    name: string;
    filePath: string;
    line: number;
  }>;
  dependencyHubs: Array<{
    filePath: string;
    imports: number;
    importedBy: number;
    inCycle: boolean;
  }>;
  risks: RepositoryArchitectureRisk[];
};

export type RepositoryArchitectureResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  summary: RepositoryArchitectureSummary;
  diagrams: {
    imports: RepositoryArchitectureDiagram;
    applicationFlow: RepositoryArchitectureDiagram;
  };
};

export interface RepositoryArchitectureServiceContract {
  getArchitecture(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositoryArchitectureResult>;
}

export type RepositoryArchitectureErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_NOT_READY"
  | "ARCHITECTURE_DATA_UNAVAILABLE"
  | "ARCHITECTURE_DATA_INVALID"
  | "ARCHITECTURE_TOO_LARGE";

export class RepositoryArchitectureError extends Error {
  override readonly name = "RepositoryArchitectureError";

  constructor(
    readonly code: RepositoryArchitectureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type BuildRepositoryArchitectureOptions = {
  maximumDiagramNodes?: number;
  maximumDiagramEdges?: number;
  maximumEntryPoints?: number;
  maximumHubs?: number;
};

type ArchitectureGraphs = {
  importGraph: RepositoryImportGraphResult;
  symbolGraph: RepositorySymbolGraphResult;
  applicationFlow: RepositoryApplicationFlowResult;
};

type RepositoryArchitectureDependencies = {
  importGraphService: RepositoryImportGraphServiceContract;
  symbolGraphService: RepositorySymbolGraphServiceContract;
  applicationFlowService: RepositoryApplicationFlowServiceContract;
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizedLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumMermaidLabelLength);
  return normalized || "Unnamed";
}

export function escapeMermaidLabel(value: string): string {
  return normalizedLabel(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");
}

function sameScope(graphs: ArchitectureGraphs): boolean {
  const scopes = [
    graphs.importGraph,
    graphs.symbolGraph,
    graphs.applicationFlow,
  ];
  return scopes.every(
    (graph) =>
      graph.repositoryId === graphs.importGraph.repositoryId &&
      graph.branch === graphs.importGraph.branch &&
      graph.commitSha === graphs.importGraph.commitSha,
  );
}

function buildImportDiagram(
  graph: RepositoryImportGraphResult,
  maximumNodes: number,
  maximumEdges: number,
): RepositoryArchitectureDiagram {
  const selectedNodes = [...graph.nodes]
    .sort(
      (left, right) =>
        right.importedBy - left.importedBy ||
        right.imports - left.imports ||
        left.path.localeCompare(right.path),
    )
    .slice(0, maximumNodes)
    .sort((left, right) => left.path.localeCompare(right.path));
  const selectedPaths = new Set(selectedNodes.map((node) => node.path));
  const candidateEdges = graph.edges
    .filter(
      (edge) =>
        selectedPaths.has(edge.source) && selectedPaths.has(edge.target),
    )
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        left.specifier.localeCompare(right.specifier),
    );
  const selectedEdges = candidateEdges.slice(0, maximumEdges);
  const ids = new Map(
    selectedNodes.map((node, index) => [node.path, `F${index}`]),
  );
  const lines = ["flowchart LR"];
  if (selectedNodes.length === 0) {
    lines.push('  EMPTY["No indexed source files"]');
  } else {
    for (const node of selectedNodes) {
      lines.push(`  ${ids.get(node.path)}["${escapeMermaidLabel(node.path)}"]`);
    }
    for (const edge of selectedEdges) {
      lines.push(`  ${ids.get(edge.source)} --> ${ids.get(edge.target)}`);
    }
  }

  return {
    mermaid: lines.join("\n"),
    nodes: selectedNodes.length,
    edges: selectedEdges.length,
    truncated:
      selectedNodes.length < graph.nodes.length ||
      selectedEdges.length < graph.edges.length,
  };
}

function buildApplicationFlowDiagram(
  flow: RepositoryApplicationFlowResult,
  maximumNodes: number,
  maximumEdges: number,
): RepositoryArchitectureDiagram {
  const selectedNodes = [...flow.nodes]
    .sort(
      (left, right) =>
        layerOrder[left.layer] - layerOrder[right.layer] ||
        left.filePath.localeCompare(right.filePath) ||
        left.startLine - right.startLine ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, maximumNodes);
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const candidateEdges = flow.edges
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
  const selectedEdges = candidateEdges.slice(0, maximumEdges);
  const ids = new Map(
    selectedNodes.map((node, index) => [node.id, `A${index}`]),
  );
  const lines = ["flowchart LR"];
  if (selectedNodes.length === 0) {
    lines.push('  EMPTY["No application flow discovered"]');
  } else {
    for (const node of selectedNodes) {
      const label = `${escapeMermaidLabel(node.layer)}: ${escapeMermaidLabel(node.name)}<br/>${escapeMermaidLabel(node.filePath)}:${node.startLine}`;
      lines.push(`  ${ids.get(node.id)}["${label}"]`);
    }
    for (const edge of selectedEdges) {
      const connector = edge.ambiguous ? "-.->" : "-->";
      lines.push(
        `  ${ids.get(edge.source)} ${connector}|"${escapeMermaidLabel(edge.reference)}"| ${ids.get(edge.target)}`,
      );
    }
    for (const node of selectedNodes) {
      lines.push(`  class ${ids.get(node.id)} ${node.layer}`);
    }
    lines.push("  classDef route fill:#e9f7c9,stroke:#4d7c0f,color:#17210b");
    lines.push(
      "  classDef controller fill:#dbeafe,stroke:#2563eb,color:#172554",
    );
    lines.push(
      "  classDef service fill:#fef3c7,stroke:#d97706,color:#451a03",
    );
    lines.push("  classDef model fill:#f3e8ff,stroke:#9333ea,color:#3b0764");
  }

  return {
    mermaid: lines.join("\n"),
    nodes: selectedNodes.length,
    edges: selectedEdges.length,
    truncated:
      selectedNodes.length < flow.nodes.length ||
      selectedEdges.length < flow.edges.length,
  };
}

function buildRisks(input: {
  graphs: ArchitectureGraphs;
  importDiagram: RepositoryArchitectureDiagram;
  applicationFlowDiagram: RepositoryArchitectureDiagram;
}): RepositoryArchitectureRisk[] {
  const { importGraph, symbolGraph, applicationFlow } = input.graphs;
  const incompleteFlows =
    applicationFlow.stats.flows - applicationFlow.stats.completeFlows;
  const risks: RepositoryArchitectureRisk[] = [];
  if (importGraph.stats.unresolvedInternalImports > 0) {
    risks.push({
      code: "UNRESOLVED_IMPORTS",
      severity: "warning",
      message: "Some repository-relative imports could not be resolved.",
      count: importGraph.stats.unresolvedInternalImports,
    });
  }
  if (importGraph.stats.cycleGroups > 0) {
    risks.push({
      code: "IMPORT_CYCLES",
      severity: "warning",
      message: "Circular file dependencies were detected.",
      count: importGraph.stats.cycleGroups,
    });
  }
  const ambiguousReferences = Math.max(
    symbolGraph.stats.ambiguousReferences,
    applicationFlow.stats.ambiguousReferences,
  );
  if (ambiguousReferences > 0) {
    risks.push({
      code: "AMBIGUOUS_REFERENCES",
      severity: "warning",
      message: "Some identifier references match more than one definition.",
      count: ambiguousReferences,
    });
  }
  if (incompleteFlows > 0) {
    risks.push({
      code: "INCOMPLETE_APPLICATION_FLOWS",
      severity: "info",
      message: "Some discovered route flows stop before reaching a model.",
      count: incompleteFlows,
    });
  }
  if (applicationFlow.stats.flowsTruncated) {
    risks.push({
      code: "TRUNCATED_FLOW_ENUMERATION",
      severity: "info",
      message: "Application-flow path enumeration reached its safety limit.",
      count: 1,
    });
  }
  const truncatedDiagrams = Number(input.importDiagram.truncated) +
    Number(input.applicationFlowDiagram.truncated);
  if (truncatedDiagrams > 0) {
    risks.push({
      code: "TRUNCATED_DIAGRAMS",
      severity: "info",
      message: "One or more diagrams were reduced to their configured display limits.",
      count: truncatedDiagrams,
    });
  }
  return risks;
}

export function buildRepositoryArchitecture(
  graphs: ArchitectureGraphs,
  options: BuildRepositoryArchitectureOptions = {},
): RepositoryArchitectureResult {
  const maximumDiagramNodes =
    options.maximumDiagramNodes ?? defaultMaximumArchitectureDiagramNodes;
  const maximumDiagramEdges =
    options.maximumDiagramEdges ?? defaultMaximumArchitectureDiagramEdges;
  const maximumEntryPoints =
    options.maximumEntryPoints ?? defaultMaximumArchitectureEntryPoints;
  const maximumHubs = options.maximumHubs ?? defaultMaximumArchitectureHubs;
  assertPositiveInteger(maximumDiagramNodes, "maximumDiagramNodes");
  assertPositiveInteger(maximumDiagramEdges, "maximumDiagramEdges");
  assertPositiveInteger(maximumEntryPoints, "maximumEntryPoints");
  assertPositiveInteger(maximumHubs, "maximumHubs");

  if (!sameScope(graphs)) {
    throw new RepositoryArchitectureError(
      "ARCHITECTURE_DATA_INVALID",
      "Repository architecture sources do not describe the same indexed commit",
    );
  }

  const importDiagram = buildImportDiagram(
    graphs.importGraph,
    maximumDiagramNodes,
    maximumDiagramEdges,
  );
  const applicationFlowDiagram = buildApplicationFlowDiagram(
    graphs.applicationFlow,
    maximumDiagramNodes,
    maximumDiagramEdges,
  );
  const languageCounts = new Map<string, number>();
  for (const node of graphs.importGraph.nodes) {
    languageCounts.set(node.language, (languageCounts.get(node.language) ?? 0) + 1);
  }
  const languages = [...languageCounts]
    .map(([name, files]) => ({ name, files }))
    .sort(
      (left, right) =>
        right.files - left.files || left.name.localeCompare(right.name),
    );
  const entryPoints = graphs.applicationFlow.nodes
    .filter((node) => node.layer === "route")
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.startLine - right.startLine ||
        left.name.localeCompare(right.name),
    )
    .slice(0, maximumEntryPoints)
    .map((node) => ({
      name: node.name,
      filePath: node.filePath,
      line: node.startLine,
    }));
  const dependencyHubs = [...graphs.importGraph.nodes]
    .filter((node) => node.importedBy > 0 || node.imports > 0)
    .sort(
      (left, right) =>
        right.importedBy - left.importedBy ||
        right.imports - left.imports ||
        left.path.localeCompare(right.path),
    )
    .slice(0, maximumHubs)
    .map((node) => ({
      filePath: node.path,
      imports: node.imports,
      importedBy: node.importedBy,
      inCycle: node.inCycle,
    }));
  const incompleteFlows =
    graphs.applicationFlow.stats.flows -
    graphs.applicationFlow.stats.completeFlows;
  const overview =
    `This indexed commit contains ${graphs.importGraph.stats.files} files and ` +
    `${graphs.symbolGraph.stats.symbols} symbols across ${languages.length} languages. ` +
    `It exposes ${graphs.applicationFlow.stats.routes} route entry points, with ` +
    `${graphs.applicationFlow.stats.completeFlows} complete route-to-model flows.`;

  return {
    repositoryId: graphs.importGraph.repositoryId,
    branch: graphs.importGraph.branch,
    commitSha: graphs.importGraph.commitSha,
    summary: {
      overview,
      metrics: {
        files: graphs.importGraph.stats.files,
        languages: languages.length,
        internalImports: graphs.importGraph.stats.internalImports,
        importCycles: graphs.importGraph.stats.cycleGroups,
        symbols: graphs.symbolGraph.stats.symbols,
        resolvedReferences: graphs.symbolGraph.stats.resolvedReferences,
        routes: graphs.applicationFlow.stats.routes,
        controllers: graphs.applicationFlow.stats.controllers,
        services: graphs.applicationFlow.stats.services,
        models: graphs.applicationFlow.stats.models,
        completeFlows: graphs.applicationFlow.stats.completeFlows,
        incompleteFlows,
      },
      languages,
      entryPoints,
      dependencyHubs,
      risks: buildRisks({
        graphs,
        importDiagram,
        applicationFlowDiagram,
      }),
    },
    diagrams: {
      imports: importDiagram,
      applicationFlow: applicationFlowDiagram,
    },
  };
}

function mapSourceError(error: unknown): RepositoryArchitectureError {
  if (
    error instanceof RepositoryImportGraphError ||
    error instanceof RepositorySymbolGraphError ||
    error instanceof RepositoryApplicationFlowError
  ) {
    switch (error.code) {
      case "INVALID_REQUEST":
        return new RepositoryArchitectureError(
          "INVALID_REQUEST",
          "Repository architecture request is invalid",
          { cause: error },
        );
      case "REPOSITORY_NOT_FOUND":
        return new RepositoryArchitectureError(
          "REPOSITORY_NOT_FOUND",
          "Repository was not found",
          { cause: error },
        );
      case "REPOSITORY_NOT_READY":
        return new RepositoryArchitectureError(
          "REPOSITORY_NOT_READY",
          "Repository indexing is not complete",
          { cause: error },
        );
      case "GRAPH_TOO_LARGE":
      case "SYMBOL_GRAPH_TOO_LARGE":
      case "FLOW_TOO_LARGE":
        return new RepositoryArchitectureError(
          "ARCHITECTURE_TOO_LARGE",
          "Repository architecture exceeds a configured safety limit",
          { cause: error },
        );
      case "GRAPH_DATA_INVALID":
      case "SYMBOL_DATA_INVALID":
      case "FLOW_DATA_INVALID":
        return new RepositoryArchitectureError(
          "ARCHITECTURE_DATA_INVALID",
          "Indexed repository architecture metadata is invalid",
          { cause: error },
        );
      default:
        return new RepositoryArchitectureError(
          "ARCHITECTURE_DATA_UNAVAILABLE",
          "Repository architecture metadata could not be loaded",
          { cause: error },
        );
    }
  }
  return new RepositoryArchitectureError(
    "ARCHITECTURE_DATA_UNAVAILABLE",
    "Repository architecture metadata could not be loaded",
    { cause: error },
  );
}

export class RepositoryArchitectureService
  implements RepositoryArchitectureServiceContract
{
  constructor(
    private readonly dependencies: RepositoryArchitectureDependencies,
    private readonly options: BuildRepositoryArchitectureOptions = {},
  ) {}

  async getArchitecture(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositoryArchitectureResult> {
    if (
      !objectIdPattern.test(input.authenticatedUserId) ||
      !objectIdPattern.test(input.repositoryId)
    ) {
      throw new RepositoryArchitectureError(
        "INVALID_REQUEST",
        "Repository architecture request is invalid",
      );
    }

    let graphs: ArchitectureGraphs;
    try {
      const [importGraph, symbolGraph, applicationFlow] = await Promise.all([
        this.dependencies.importGraphService.getGraph(input),
        this.dependencies.symbolGraphService.getGraph(input),
        this.dependencies.applicationFlowService.getFlow(input),
      ]);
      graphs = { importGraph, symbolGraph, applicationFlow };
    } catch (error) {
      throw mapSourceError(error);
    }

    return buildRepositoryArchitecture(graphs, this.options);
  }
}

let defaultRepositoryArchitectureService:
  | RepositoryArchitectureService
  | undefined;

export function getDefaultRepositoryArchitectureService(): RepositoryArchitectureService {
  defaultRepositoryArchitectureService ??= new RepositoryArchitectureService({
    importGraphService: getDefaultRepositoryImportGraphService(),
    symbolGraphService: getDefaultRepositorySymbolGraphService(),
    applicationFlowService: getDefaultRepositoryApplicationFlowService(),
  });
  return defaultRepositoryArchitectureService;
}
