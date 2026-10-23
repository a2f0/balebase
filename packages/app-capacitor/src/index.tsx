import { renderApp } from "@balebase/app/client";
import { handleBackButton } from "./backButton";
import { capacitorHost } from "./host";
import { syncSystemBars } from "./systemBars";

handleBackButton();
syncSystemBars();
renderApp(
  capacitorHost(import.meta.env.VITE_APP_URL ?? "https://app.balebase.com"),
);
