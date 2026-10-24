import { DialogHost } from "@balebase/ui/react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { authClient } from "../src/authClient";
import "./offlineFixture";

const testApi = {
  mount: () => {
    const root = document.getElementById("root");
    if (root)
      createRoot(root).render(
        <>
          <App />
          <DialogHost />
          <SessionState />
        </>,
      );
  },
  refreshSession: () => authClient.$store.notify("$sessionSignal"),
};
declare global {
  interface Window {
    offlineAppTest: typeof testApi;
  }
}
window.offlineAppTest = testApi;

function SessionState() {
  const { data, isPending, error } = authClient.useSession();
  return (
    <output id="session-state">
      {isPending
        ? "pending"
        : error
          ? "error"
          : (data?.user.id ?? "signed-out")}
    </output>
  );
}
