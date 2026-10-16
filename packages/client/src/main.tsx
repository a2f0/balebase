import { DialogHost, ToastProvider } from "@balebase/ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@balebase/ui/styles.css";
import { App } from "./App";
import "./styles/app.css";
import { startThemeSync } from "./theme";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found.");
}

startThemeSync();

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
      <DialogHost />
    </ToastProvider>
  </StrictMode>,
);
