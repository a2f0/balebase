import type { Bindings } from "./types";

export function clientOrigins(env: Bindings) {
  return [env.CORS_ORIGIN, "capacitor://localhost", "https://localhost"];
}
