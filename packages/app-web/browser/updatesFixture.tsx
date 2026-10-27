import { DialogHost, ToastProvider } from "@balebase/ui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebUpdates } from "../src/WebUpdates";

export function mount(version: string) {
  sessionStorage.setItem(
    "loads",
    String(Number(sessionStorage.getItem("loads") || 0) + 1),
  );
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing fixture root");
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <p id="version">{version}</p>
        <input aria-label="Draft" />
        <WebUpdates />
        <DialogHost />
      </ToastProvider>
    </StrictMode>,
  );
}
