import type { Context } from "hono";
import type { ApiEnv } from "./authMiddleware";

export type FinanceContext = Context<ApiEnv>;
