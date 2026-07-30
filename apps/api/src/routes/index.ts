import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import {
  createQuestionRouter,
  type CreateQuestionRouterOptions,
} from "./question.routes.js";
import {
  createRepositoryRouter,
  type CreateRepositoryRouterOptions,
} from "./repository.routes.js";

export type CreateApiRouterOptions = {
  question?: CreateQuestionRouterOptions;
  repository?: CreateRepositoryRouterOptions;
};

export function createApiRouter(options: CreateApiRouterOptions = {}): Router {
  const router = Router();
  router.use(healthRouter);
  router.use(createRepositoryRouter(options.repository));
  router.use(createQuestionRouter(options.question));
  return router;
}
