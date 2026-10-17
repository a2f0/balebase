import type { Bindings } from "./types";

export function clientOrigins(env: Bindings) {
  // Better Auth also permits these fixed origins as callback destinations.
  // Native email links deliberately use the hosted app; never allow wildcard
  // localhost ports or arbitrary custom-scheme hosts here.
  return [env.CORS_ORIGIN, "capacitor://localhost", "https://localhost"];
}
