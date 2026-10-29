import type { Context } from "hono";
import type { ApiEnv } from "../auth/apiEnv";

export type FinanceContext = Context<ApiEnv>;
