import path from "node:path";

import {
  RepositoryFileModel,
  RepositoryModel,
} from "@codebase-explainer/database";
import mongoose from "mongoose";

const { Types, trusted } = mongoose;

export const defaultMaximumRepositoryImportGraphFiles = 5_000;
export const defaultMaximumRepositoryImportGraphImports = 50_000;

const objectIdPattern = /^[0-9a-f]{24}$/iu;
const sourceExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
] as const;
const emittedJavaScriptExtensions = new Set([".js", ".jsx", ".mjs", ".cjs"]);

export type RepositoryImportGraphFile = {
  path: string;
  language: string;
  imports: readonly string[];
};

export type RepositoryImportGraphRecord = {
  id: string;
  branch: string;
  status: string;
  lastIndexedCommit?: string;
};

export type RepositoryImportGraphNode = {
  id: string;
  path: string;
  language: string;
  imports: number;
  importedBy: number;
  inCycle: boolean;
};

export type RepositoryImportGraphEdge = {
  source: string;
  target: string;
  specifier: string;
};

export type RepositoryUnresolvedImport = {
  source: string;
  specifier: string;
};

export type RepositoryImportGraphResult = {
  repositoryId: string;
  branch: string;
  commitSha: string;
  nodes: RepositoryImportGraphNode[];
  edges: RepositoryImportGraphEdge[];
  unresolvedImports: RepositoryUnresolvedImport[];
  cycles: string[][];
  stats: {
    files: number;
    internalImports: number;
    unresolvedInternalImports: number;
    cyclicFiles: number;
    cycleGroups: number;
  };
};

export interface RepositoryImportGraphGateway {
  findOwnedRepository(input: {
    repositoryId: string;
    authenticatedUserId: string;
  }): Promise<RepositoryImportGraphRecord | null>;
  listFiles(input: {
    repositoryId: string;
    branch: string;
    commitSha: string;
    limit: number;
  }): Promise<RepositoryImportGraphFile[]>;
}

export type RepositoryImportGraphErrorCode =
  | "INVALID_REQUEST"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_NOT_READY"
  | "REPOSITORY_ACCESS_FAILED"
  | "GRAPH_DATA_UNAVAILABLE"
  | "GRAPH_DATA_INVALID"
  | "GRAPH_TOO_LARGE";

export class RepositoryImportGraphError extends Error {
  override readonly name = "RepositoryImportGraphError";

  constructor(
    readonly code: RepositoryImportGraphErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RepositoryImportGraphServiceContract {
  getGraph(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositoryImportGraphResult>;
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizeRepositoryPath(value: string): string {
  if (!value.trim() || value.includes("\0")) {
    throw new RepositoryImportGraphError(
      "GRAPH_DATA_INVALID",
      "Indexed repository file metadata is invalid",
    );
  }

  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new RepositoryImportGraphError(
      "GRAPH_DATA_INVALID",
      "Indexed repository file metadata is invalid",
    );
  }
  return normalized;
}

function internalImportSpecifier(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 2_048 ||
    trimmed.includes("\0") ||
    (!trimmed.startsWith("./") && !trimmed.startsWith("../"))
  ) {
    return undefined;
  }
  return trimmed.split(/[?#]/u, 1)[0] || undefined;
}

function importCandidates(sourcePath: string, specifier: string): string[] {
  const basePath = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), specifier),
  );
  if (
    basePath === ".." ||
    basePath.startsWith("../") ||
    path.posix.isAbsolute(basePath)
  ) {
    return [];
  }

  const extension = path.posix.extname(basePath).toLowerCase();
  if (extension) {
    const candidates = [basePath];
    if (emittedJavaScriptExtensions.has(extension)) {
      const withoutExtension = basePath.slice(0, -extension.length);
      candidates.push(
        `${withoutExtension}.ts`,
        `${withoutExtension}.tsx`,
        `${withoutExtension}.mts`,
        `${withoutExtension}.cts`,
      );
    }
    return [...new Set(candidates)];
  }

  return [
    basePath,
    ...sourceExtensions.map((candidateExtension) =>
      `${basePath}${candidateExtension}`,
    ),
    ...sourceExtensions.map((candidateExtension) =>
      path.posix.join(basePath, `index${candidateExtension}`),
    ),
  ];
}

function findCycles(
  paths: readonly string[],
  edges: readonly RepositoryImportGraphEdge[],
): string[][] {
  const adjacency = new Map(paths.map((filePath) => [filePath, [] as string[]]));
  const reverse = new Map(paths.map((filePath) => [filePath, [] as string[]]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    reverse.get(edge.target)?.push(edge.source);
  }
  for (const values of [...adjacency.values(), ...reverse.values()]) {
    values.sort((left, right) => left.localeCompare(right));
  }

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const root of paths) {
    if (visited.has(root)) {
      continue;
    }
    const stack: Array<{ path: string; expanded: boolean }> = [
      { path: root, expanded: false },
    ];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.expanded) {
        finishOrder.push(current.path);
        continue;
      }
      if (visited.has(current.path)) {
        continue;
      }
      visited.add(current.path);
      stack.push({ path: current.path, expanded: true });
      const neighbours = adjacency.get(current.path) ?? [];
      for (let index = neighbours.length - 1; index >= 0; index -= 1) {
        const neighbour = neighbours[index]!;
        if (!visited.has(neighbour)) {
          stack.push({ path: neighbour, expanded: false });
        }
      }
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const root = finishOrder[index]!;
    if (assigned.has(root)) {
      continue;
    }
    const component: string[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbour of reverse.get(current) ?? []) {
        if (!assigned.has(neighbour)) {
          assigned.add(neighbour);
          stack.push(neighbour);
        }
      }
    }
    component.sort((left, right) => left.localeCompare(right));
    const isSelfCycle =
      component.length === 1 &&
      (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length > 1 || isSelfCycle) {
      components.push(component);
    }
  }

  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
}

export function buildRepositoryImportGraph(
  files: readonly RepositoryImportGraphFile[],
  maximumImports = defaultMaximumRepositoryImportGraphImports,
): Pick<
  RepositoryImportGraphResult,
  "nodes" | "edges" | "unresolvedImports" | "cycles" | "stats"
> {
  assertPositiveInteger(maximumImports, "maximumImports");
  const filesByPath = new Map<string, RepositoryImportGraphFile>();
  let inspectedImports = 0;
  for (const file of files) {
    const filePath = normalizeRepositoryPath(file.path);
    if (filesByPath.has(filePath)) {
      throw new RepositoryImportGraphError(
        "GRAPH_DATA_INVALID",
        "Indexed repository file metadata is invalid",
      );
    }
    filesByPath.set(filePath, { ...file, path: filePath });
  }

  const paths = [...filesByPath.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const edges: RepositoryImportGraphEdge[] = [];
  const unresolvedImports: RepositoryUnresolvedImport[] = [];
  const seenEdges = new Set<string>();
  const seenUnresolved = new Set<string>();

  for (const source of paths) {
    const file = filesByPath.get(source)!;
    for (const rawSpecifier of file.imports) {
      const specifier = internalImportSpecifier(rawSpecifier);
      if (specifier === undefined) {
        continue;
      }
      inspectedImports += 1;
      if (inspectedImports > maximumImports) {
        throw new RepositoryImportGraphError(
          "GRAPH_TOO_LARGE",
          "The repository import graph exceeds the configured import limit",
        );
      }

      const target = importCandidates(source, specifier).find((candidate) =>
        filesByPath.has(candidate),
      );
      if (target === undefined) {
        const key = `${source}\0${specifier}`;
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolvedImports.push({ source, specifier });
        }
        continue;
      }

      const key = `${source}\0${target}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ source, target, specifier });
      }
    }
  }

  edges.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      left.specifier.localeCompare(right.specifier),
  );
  unresolvedImports.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.specifier.localeCompare(right.specifier),
  );

  const cycles = findCycles(paths, edges);
  const cyclicPaths = new Set(cycles.flat());
  const outgoing = new Map(paths.map((filePath) => [filePath, 0]));
  const incoming = new Map(paths.map((filePath) => [filePath, 0]));
  for (const edge of edges) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const nodes = paths.map((filePath): RepositoryImportGraphNode => {
    const file = filesByPath.get(filePath)!;
    return {
      id: filePath,
      path: filePath,
      language: file.language,
      imports: outgoing.get(filePath) ?? 0,
      importedBy: incoming.get(filePath) ?? 0,
      inCycle: cyclicPaths.has(filePath),
    };
  });

  return {
    nodes,
    edges,
    unresolvedImports,
    cycles,
    stats: {
      files: nodes.length,
      internalImports: edges.length,
      unresolvedInternalImports: unresolvedImports.length,
      cyclicFiles: cyclicPaths.size,
      cycleGroups: cycles.length,
    },
  };
}

export class RepositoryImportGraphService
  implements RepositoryImportGraphServiceContract
{
  private readonly maximumFiles: number;
  private readonly maximumImports: number;

  constructor(
    private readonly gateway: RepositoryImportGraphGateway,
    options: { maximumFiles?: number; maximumImports?: number } = {},
  ) {
    this.maximumFiles =
      options.maximumFiles ?? defaultMaximumRepositoryImportGraphFiles;
    this.maximumImports =
      options.maximumImports ?? defaultMaximumRepositoryImportGraphImports;
    assertPositiveInteger(this.maximumFiles, "maximumFiles");
    assertPositiveInteger(this.maximumImports, "maximumImports");
  }

  async getGraph(input: {
    authenticatedUserId: string;
    repositoryId: string;
  }): Promise<RepositoryImportGraphResult> {
    if (
      !objectIdPattern.test(input.authenticatedUserId) ||
      !objectIdPattern.test(input.repositoryId)
    ) {
      throw new RepositoryImportGraphError(
        "INVALID_REQUEST",
        "Repository import graph request is invalid",
      );
    }

    let repository: RepositoryImportGraphRecord | null;
    try {
      repository = await this.gateway.findOwnedRepository(input);
    } catch (error) {
      throw new RepositoryImportGraphError(
        "REPOSITORY_ACCESS_FAILED",
        "The repository could not be accessed",
        { cause: error },
      );
    }
    if (repository === null) {
      throw new RepositoryImportGraphError(
        "REPOSITORY_NOT_FOUND",
        "Repository was not found",
      );
    }
    if (repository.status !== "ready" || !repository.lastIndexedCommit) {
      throw new RepositoryImportGraphError(
        "REPOSITORY_NOT_READY",
        "Repository indexing is not complete",
      );
    }

    let files: RepositoryImportGraphFile[];
    try {
      files = await this.gateway.listFiles({
        repositoryId: repository.id,
        branch: repository.branch,
        commitSha: repository.lastIndexedCommit,
        limit: this.maximumFiles + 1,
      });
    } catch (error) {
      throw new RepositoryImportGraphError(
        "GRAPH_DATA_UNAVAILABLE",
        "Repository import metadata could not be loaded",
        { cause: error },
      );
    }
    if (files.length > this.maximumFiles) {
      throw new RepositoryImportGraphError(
        "GRAPH_TOO_LARGE",
        "The repository import graph exceeds the configured file limit",
      );
    }

    const graph = buildRepositoryImportGraph(files, this.maximumImports);
    return {
      repositoryId: repository.id,
      branch: repository.branch,
      commitSha: repository.lastIndexedCommit,
      ...graph,
    };
  }
}

export class MongooseRepositoryImportGraphGateway
  implements RepositoryImportGraphGateway
{
  async findOwnedRepository(input: {
    repositoryId: string;
    authenticatedUserId: string;
  }): Promise<RepositoryImportGraphRecord | null> {
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
  }): Promise<RepositoryImportGraphFile[]> {
    const files = await RepositoryFileModel.find({
      repositoryId: new Types.ObjectId(input.repositoryId),
      branch: input.branch,
      commitSha: input.commitSha,
    })
      .select("path language imports")
      .sort({ path: 1 })
      .limit(input.limit)
      .lean()
      .exec();
    return files.map((file) => ({
      path: file.path,
      language: file.language,
      imports: [...file.imports],
    }));
  }
}

let defaultRepositoryImportGraphService:
  | RepositoryImportGraphService
  | undefined;

export function getDefaultRepositoryImportGraphService(): RepositoryImportGraphService {
  defaultRepositoryImportGraphService ??= new RepositoryImportGraphService(
    new MongooseRepositoryImportGraphGateway(),
  );
  return defaultRepositoryImportGraphService;
}
