import { renderApp } from "@balebase/app/client";
import { capacitorHost } from "./host";
import { syncStatusBarStyle } from "./statusBar";

syncStatusBarStyle();
renderApp(
  capacitorHost(import.meta.env.VITE_APP_URL ?? "https://app.balebase.com"),
);
