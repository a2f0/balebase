import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { authClient } from "../src/authClient";
import "./offlineFixture";

const testApi = {
  mount: () => {
    const root = document.getElementById("root");
    if (root) createRoot(root).render(<App />);
  },
  refreshSession: () => authClient.$store.notify("$sessionSignal"),
};
declare global {
  interface Window {
    offlineAppTest: typeof testApi;
  }
}
window.offlineAppTest = testApi;
