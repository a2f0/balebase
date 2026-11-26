import { DialogHost } from "@balebase/ui/react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { balebase } from "../src/balebase";
import { useSession } from "../src/shared/useSession";
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
  refreshSession: () => balebase().auth.$store.notify("$sessionSignal"),
};
declare global {
  interface Window {
    offlineAppTest: typeof testApi;
  }
}
window.offlineAppTest = testApi;

function SessionState() {
  const { data, isPending, error } = useSession();
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
