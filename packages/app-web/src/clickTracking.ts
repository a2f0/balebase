import { createTracker } from "@a2f0/ct-client";

const pages = new Set([
  "/",
  "/account",
  "/account/security",
  "/activity",
  "/add-account",
  "/audits",
  "/businesses",
  "/contracts",
  "/contracts/templates",
  "/equipment",
  "/finance",
  "/finance/categories",
  "/finance/connections",
  "/finance/reports",
  "/inbox",
  "/invite",
  "/issues",
  "/library",
  "/me",
  "/organization",
  "/organization/access",
  "/organization/api-keys",
  "/organization/billing",
  "/organization/people",
  "/reset-password",
  "/root/global-audits",
  "/root/jobs",
  "/root/organizations",
  "/root/users",
]);
const recordPages = [
  "/audits",
  "/businesses",
  "/contracts/templates",
  "/contracts",
  "/equipment",
  "/finance/accounts",
  "/finance/categories",
  "/finance/connections",
  "/finance/transactions",
  "/issues",
  "/library",
  "/me/screening",
  "/organization/people",
  "/root/global-audits",
  "/root/organizations",
  "/sign",
];

// Only return finite labels. Even an unexpected URL must never expose a record
// ID, signing token, query, or hash to the public click dashboard.
function clickPage() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  if (pages.has(path)) return path;
  const record = recordPages.find((prefix) => path.startsWith(`${prefix}/`));
  return record ? `${record}/:record` : "/other";
}

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
    page: clickPage,
  });
  tracker.init();
  return tracker;
}
