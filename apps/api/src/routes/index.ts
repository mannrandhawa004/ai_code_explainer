import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import {
  createQuestionRouter,
  type CreateQuestionRouterOptions,
} from "./question.routes.js";

export type CreateApiRouterOptions = {
  question?: CreateQuestionRouterOptions;
};

export function createApiRouter(options: CreateApiRouterOptions = {}): Router {
  const router = Router();
  router.use(healthRouter);
  router.use(createQuestionRouter(options.question));
  return router;
}
