import { createTracker } from "@a2f0/ct-client";

export function initClickTracking() {
  if (typeof window === "undefined" || !import.meta.env.PROD) return;
  const environment =
    window.location.origin === "https://app.balebase.com"
      ? "production"
      : window.location.origin === "https://app-staging.balebase.com"
        ? "staging"
        : undefined;
  if (!environment) return;
  const tracker = createTracker({
    site: "balebase",
    app: "web-app",
    environment,
    capture: "all",
    // Keep the default page "/". Public clicks must not reveal workspace
    // workflows, including screening, signing, finance, or admin activity.
  });
  tracker.init();
  return tracker;
}
