import { DialogHost, ToastProvider } from "@balebase/ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@balebase/ui/styles.css";
import { App } from "./App";
import { type AppHost, configureHost } from "./host";
import "./styles/app.css";
import { startThemeSync } from "./theme";

/** Renders the workspace into the shell's #root with its host services. */
export function renderApp(host: AppHost = {}) {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element not found.");
  }

  configureHost(host);
  startThemeSync();

  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <App />
        <DialogHost />
      </ToastProvider>
    </StrictMode>,
  );
}
