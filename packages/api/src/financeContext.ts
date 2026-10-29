import type { Context } from "hono";
import type { ApiEnv } from "./auth/authMiddleware";

export type FinanceContext = Context<ApiEnv>;
