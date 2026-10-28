import { createTracker } from "@a2f0/ct-client";
import type { ReleaseTier } from "./config";

interface ClickTrackingOptions {
  app: string;
  /** The exact origin of each deployed tier, as registered with CT. */
  origins: Record<ReleaseTier, string>;
  /** A fixed page name; CT's default "/" reveals no route at all. */
  page?: () => string;
}

/** Only a production bundle served from a registered origin starts a tracker. */
export function initClickTracking({
  app,
  origins,
  page,
}: ClickTrackingOptions) {
  if (typeof window === "undefined" || !import.meta.env.PROD) return;
  const environment =
    window.location.origin === origins.production
      ? "production"
      : window.location.origin === origins.staging
        ? "staging"
        : undefined;
  if (!environment) return;
  const tracker = createTracker({
    site: "balebase",
    app,
    environment,
    capture: "all",
    ...(page && { page }),
  });
  tracker.init();
  return tracker;
}
