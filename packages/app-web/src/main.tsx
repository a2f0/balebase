import { renderApp } from "@balebase/app/client";
import { initClickTracking } from "./clickTracking";

renderApp();
const clicks = initClickTracking();
import.meta.hot?.dispose(() => clicks?.destroy());
