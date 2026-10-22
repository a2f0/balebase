import { createTracker } from "@a2f0/ct-client";

const pages = new Set(["/", "/privacy", "/terms", "/data-retention"]);

export function initClickTracking() {
  if (typeof window === "undefined" || !import.meta.env.PROD) return;
  const environment =
    window.location.origin === "https://balebase.com"
      ? "production"
      : window.location.origin === "https://website-staging.balebase.com"
        ? "staging"
        : undefined;
  if (!environment) return;
  const tracker = createTracker({
    site: "balebase",
    app: "website",
    environment,
    capture: "all",
    page: () => {
      const path = window.location.pathname.replace(/\/$/, "") || "/";
      return pages.has(path) ? path : "/other";
    },
  });
  tracker.init();
  return tracker;
}
