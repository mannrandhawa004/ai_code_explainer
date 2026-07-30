import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type PublicGitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
};

export type PublicRepositoryCloneRequest = {
  repositoryUrl: string;
  branch?: string;
  signal?: AbortSignal;
};

export type ClonedPublicRepository = PublicGitHubRepository & {
  directory: string;
  branch: string;
  commitSha: string;
};

export type PublicRepositoryCloneConfig = {
  tempRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CloneCommandResult = {
  stdout: string;
  stderr: string;
};

export type CloneCommandRunner = (
  arguments_: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    gitConfigPath: string;
    signal?: AbortSignal;
  },
) => Promise<CloneCommandResult>;

export type RepositoryCloneErrorCode =
  | "INVALID_REPOSITORY_URL"
  | "INVALID_BRANCH"
  | "CLONE_ABORTED"
  | "CLONE_FAILED"
  | "METADATA_FAILED"
  | "CLEANUP_FAILED";

export class RepositoryCloneError extends Error {
  override readonly name = "RepositoryCloneError";

  constructor(
    readonly code: RepositoryCloneErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const defaultConfig: PublicRepositoryCloneConfig = {
  tempRoot: path.join(tmpdir(), "ai-codebase-explainer"),
  timeoutMs: 120_000,
  maxOutputBytes: 1_000_000,
};

const githubOwnerPattern = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const forbiddenBranchCharacters = /[\u0000-\u0020\u007f~^:?*\[\\]/;

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createGitEnvironment(gitConfigPath: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith("GIT_") &&
        key.toUpperCase() !== "GCM_INTERACTIVE",
    ),
  );

  return {
    ...environment,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
}

function defaultCommandRunner(
  arguments_: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    gitConfigPath: string;
    signal?: AbortSignal;
  },
): Promise<CloneCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...arguments_],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        windowsHide: true,
        encoding: "utf8",
        env: createGitEnvironment(options.gitConfigPath),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

export function normalizePublicGitHubRepository(
  repositoryUrl: string,
): PublicGitHubRepository {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(repositoryUrl);
  } catch (cause) {
    throw new RepositoryCloneError(
      "INVALID_REPOSITORY_URL",
      "A valid public GitHub repository URL is required",
      { cause },
    );
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname.toLowerCase() !== "github.com" ||
    parsedUrl.port !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.pathname.includes("%")
  ) {
    throw new RepositoryCloneError(
      "INVALID_REPOSITORY_URL",
      "Only canonical HTTPS GitHub repository URLs are allowed",
    );
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);

  if (segments.length !== 2) {
    throw new RepositoryCloneError(
      "INVALID_REPOSITORY_URL",
      "GitHub repository URL must contain exactly an owner and repository",
    );
  }

  const owner = segments[0] as string;
  const rawName = segments[1] as string;
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;

  if (
    !githubOwnerPattern.test(owner) ||
    !githubRepositoryPattern.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new RepositoryCloneError(
      "INVALID_REPOSITORY_URL",
      "GitHub owner or repository name is invalid",
    );
  }

  const fullName = `${owner}/${name}`;

  return {
    owner,
    name,
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
  };
}

export function validateGitBranch(branch: string): string {
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    branch !== branch.trim() ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch === "@" ||
    forbiddenBranchCharacters.test(branch)
  ) {
    throw new RepositoryCloneError(
      "INVALID_BRANCH",
      "Git branch name is invalid",
    );
  }

  const invalidComponent = branch
    .split("/")
    .some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.toLowerCase().endsWith(".lock"),
    );

  if (invalidComponent) {
    throw new RepositoryCloneError(
      "INVALID_BRANCH",
      "Git branch name is invalid",
    );
  }

  return branch;
}

export class PublicRepositoryCloner {
  readonly config: PublicRepositoryCloneConfig;

  constructor(
    config: Partial<PublicRepositoryCloneConfig> = {},
    private readonly runCommand: CloneCommandRunner = defaultCommandRunner,
  ) {
    this.config = { ...defaultConfig, ...config };

    if (this.config.timeoutMs <= 0 || this.config.maxOutputBytes <= 0) {
      throw new Error("Clone timeout and output limit must be positive");
    }
  }

  async withClone<Result>(
    request: PublicRepositoryCloneRequest,
    operation: (repository: ClonedPublicRepository) => Promise<Result>,
  ): Promise<Result> {
    const repository = normalizePublicGitHubRepository(request.repositoryUrl);
    const requestedBranch =
      request.branch === undefined ? undefined : validateGitBranch(request.branch);
    const tempRoot = path.resolve(this.config.tempRoot);

    this.assertNotAborted(request.signal);

    await fs.mkdir(tempRoot, { recursive: true });
    const resolvedTempRoot = await fs.realpath(tempRoot);
    const sessionDirectory = await fs.mkdtemp(
      path.join(resolvedTempRoot, "repository-"),
    );

    if (!pathIsInside(resolvedTempRoot, sessionDirectory)) {
      throw new RepositoryCloneError(
        "CLEANUP_FAILED",
        "Temporary repository path escaped its configured root",
      );
    }

    const repositoryDirectory = path.join(sessionDirectory, "source");
    const gitConfigPath = path.join(sessionDirectory, "gitconfig");
    await fs.writeFile(gitConfigPath, "", { encoding: "utf8", flag: "wx" });

    try {
      await this.clone(
        repository,
        requestedBranch,
        repositoryDirectory,
        resolvedTempRoot,
        gitConfigPath,
        request.signal,
      );
      const metadata = await this.readMetadata(
        repositoryDirectory,
        repository,
        gitConfigPath,
        request.signal,
      );

      return await operation({
        ...repository,
        directory: repositoryDirectory,
        branch: metadata.branch,
        commitSha: metadata.commitSha,
      });
    } finally {
      try {
        await fs.rm(sessionDirectory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      } catch (cause) {
        throw new RepositoryCloneError(
          "CLEANUP_FAILED",
          "Temporary repository cleanup failed",
          { cause },
        );
      }
    }
  }

  private async clone(
    repository: PublicGitHubRepository,
    branch: string | undefined,
    destination: string,
    workingDirectory: string,
    gitConfigPath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const arguments_ = [
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      ...(branch === undefined ? [] : ["--branch", branch]),
      "--",
      repository.cloneUrl,
      destination,
    ];

    try {
      await this.runCommand(arguments_, {
        cwd: workingDirectory,
        timeoutMs: this.config.timeoutMs,
        maxOutputBytes: this.config.maxOutputBytes,
        gitConfigPath,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted) {
        throw new RepositoryCloneError(
          "CLONE_ABORTED",
          "Repository cloning was cancelled",
          { cause: signal.reason ?? cause },
        );
      }
      throw new RepositoryCloneError(
        "CLONE_FAILED",
        `Unable to clone public GitHub repository ${repository.fullName}`,
        { cause },
      );
    }
  }

  private async readMetadata(
    repositoryDirectory: string,
    repository: PublicGitHubRepository,
    gitConfigPath: string,
    signal: AbortSignal | undefined,
  ): Promise<{ branch: string; commitSha: string }> {
    this.assertNotAborted(signal);

    try {
      const [branchResult, commitResult] = await Promise.all([
        this.runCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repositoryDirectory,
          timeoutMs: this.config.timeoutMs,
          maxOutputBytes: this.config.maxOutputBytes,
          gitConfigPath,
          ...(signal === undefined ? {} : { signal }),
        }),
        this.runCommand(["rev-parse", "HEAD"], {
          cwd: repositoryDirectory,
          timeoutMs: this.config.timeoutMs,
          maxOutputBytes: this.config.maxOutputBytes,
          gitConfigPath,
          ...(signal === undefined ? {} : { signal }),
        }),
      ]);
      const branch = branchResult.stdout.trim();
      const commitSha = commitResult.stdout.trim().toLowerCase();

      if (!branch || !/^[0-9a-f]{40,64}$/.test(commitSha)) {
        throw new Error("Git returned invalid repository metadata");
      }

      return { branch, commitSha };
    } catch (cause) {
      throw new RepositoryCloneError(
        "METADATA_FAILED",
        `Unable to read cloned repository metadata for ${repository.fullName}`,
        { cause },
      );
    }
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new RepositoryCloneError(
        "CLONE_ABORTED",
        "Repository cloning was cancelled",
        { cause: signal.reason },
      );
    }
  }
}
