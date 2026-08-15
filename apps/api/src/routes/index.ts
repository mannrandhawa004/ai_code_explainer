import { Router } from "express";

import {
  createAuthRouter,
  type CreateAuthRouterOptions,
} from "./auth.routes.js";
import { healthRouter } from "./health.routes.js";
import {
  createGitHubRouter,
  type CreateGitHubRouterOptions,
} from "./github.routes.js";
import {
  createQuestionRouter,
  type CreateQuestionRouterOptions,
} from "./question.routes.js";
import {
  createRepositoryRouter,
  type CreateRepositoryRouterOptions,
} from "./repository.routes.js";
import {
  createRepositoryImportGraphRouter,
  type CreateRepositoryImportGraphRouterOptions,
} from "./repository-import-graph.routes.js";
import {
  createRepositorySymbolGraphRouter,
  type CreateRepositorySymbolGraphRouterOptions,
} from "./repository-symbol-graph.routes.js";
import {
  createRepositoryApplicationFlowRouter,
  type CreateRepositoryApplicationFlowRouterOptions,
} from "./repository-application-flow.routes.js";
import {
  createRepositoryArchitectureRouter,
  type CreateRepositoryArchitectureRouterOptions,
} from "./repository-architecture.routes.js";
import {
  createRepositoryDependencyExplorationRouter,
  type CreateRepositoryDependencyExplorationRouterOptions,
} from "./repository-dependency-exploration.routes.js";

export type CreateApiRouterOptions = {
  auth?: CreateAuthRouterOptions;
  github?: CreateGitHubRouterOptions;
  question?: CreateQuestionRouterOptions;
  repository?: CreateRepositoryRouterOptions;
  repositoryImportGraph?: CreateRepositoryImportGraphRouterOptions;
  repositorySymbolGraph?: CreateRepositorySymbolGraphRouterOptions;
  repositoryApplicationFlow?: CreateRepositoryApplicationFlowRouterOptions;
  repositoryArchitecture?: CreateRepositoryArchitectureRouterOptions;
  repositoryDependencyExploration?: CreateRepositoryDependencyExplorationRouterOptions;
};

export function createApiRouter(options: CreateApiRouterOptions = {}): Router {
  const router = Router();
  router.use(healthRouter);
  router.use(createAuthRouter(options.auth));
  router.use(createGitHubRouter(options.github));
  router.use(createRepositoryRouter(options.repository));
  router.use(createRepositoryImportGraphRouter(options.repositoryImportGraph));
  router.use(createRepositorySymbolGraphRouter(options.repositorySymbolGraph));
  router.use(
    createRepositoryApplicationFlowRouter(options.repositoryApplicationFlow),
  );
  router.use(createRepositoryArchitectureRouter(options.repositoryArchitecture));
  router.use(
    createRepositoryDependencyExplorationRouter(
      options.repositoryDependencyExploration,
    ),
  );
  router.use(createQuestionRouter(options.question));
  return router;
}
