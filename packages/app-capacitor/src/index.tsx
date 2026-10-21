import { renderApp } from "@balebase/app/client";
import { capacitorHost } from "./host";
import { syncSystemBars } from "./systemBars";

syncSystemBars();
renderApp(
  capacitorHost(import.meta.env.VITE_APP_URL ?? "https://app.balebase.com"),
);
