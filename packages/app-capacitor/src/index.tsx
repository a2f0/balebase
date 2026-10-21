import { renderApp } from "@balebase/app/client";
import { capacitorHost } from "./host";

renderApp(
  capacitorHost(import.meta.env.VITE_APP_URL ?? "https://app.balebase.com"),
);
