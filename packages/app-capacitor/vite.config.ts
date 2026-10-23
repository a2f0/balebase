import { pdfjsAssets } from "@balebase/app/vite";
import { sentryAssets } from "@balebase/diagnostics/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The bundle talks to the tier's hosted API unless VITE_* in the environment
// or .env.local says otherwise; the release wrappers and Fastlane hold store
// builds to the tier's own hosts.
const tierUrls = {
  production: {
    VITE_API_URL: "https://api.balebase.com",
    VITE_APP_URL: "https://app.balebase.com",
  },
  staging: {
    VITE_API_URL: "https://api-staging.balebase.com",
    VITE_APP_URL: "https://app-staging.balebase.com",
  },
};

export default defineConfig(({ mode }) => {
  const { NATIVE_RELEASE_TIER } = process.env;
  const tier = (NATIVE_RELEASE_TIER ?? "production").trim().toLowerCase();
  if (tier !== "production" && tier !== "staging") {
    throw new Error(`Unknown NATIVE_RELEASE_TIER=${JSON.stringify(tier)}.`);
  }
  const { VITE_API_URL, VITE_APP_URL } = loadEnv(mode, process.cwd());
  const urls = {
    VITE_API_URL: VITE_API_URL ?? tierUrls[tier].VITE_API_URL,
    VITE_APP_URL: VITE_APP_URL ?? tierUrls[tier].VITE_APP_URL,
  };
  for (const [name, url] of Object.entries(urls)) {
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error(`${name} must be a valid HTTPS URL for mobile builds.`);
    }
    if (protocol !== "https:") {
      throw new Error(`${name} must use HTTPS for mobile builds.`);
    }
  }
  return {
    plugins: [react(), pdfjsAssets(), sentryAssets()],
    define: Object.fromEntries(
      Object.entries(urls).map(([name, url]) => [
        `import.meta.env.${name}`,
        JSON.stringify(url),
      ]),
    ),
  };
});
