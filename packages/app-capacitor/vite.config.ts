import { pdfjsAssets } from "@balebase/app/vite";
import { sentryAssets } from "@balebase/diagnostics/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { nativeReleaseTarget } from "./nativeReleaseTarget.ts";

// The bundle talks to the tier's hosted API and app unless VITE_* in the
// environment or .env.local says otherwise. Any mobile build needs HTTPS; the
// Fastlane release lanes also hold store builds to the tier's own hosts.
export default defineConfig(({ mode }) => {
  const { apiHost, appHost } = nativeReleaseTarget();
  const { VITE_API_URL, VITE_APP_URL } = loadEnv(mode, process.cwd());
  const urls = {
    VITE_API_URL: VITE_API_URL ?? `https://${apiHost}`,
    VITE_APP_URL: VITE_APP_URL ?? `https://${appHost}`,
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
