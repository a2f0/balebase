import { pdfjsAssets } from "@balebase/app/vite";
import { sentryAssets } from "@balebase/diagnostics/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), pdfjsAssets(), sentryAssets()],
});
