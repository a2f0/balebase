import { pdfjsAssets } from "@balebase/app/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [react(), pdfjsAssets()] });
