// Bundled into the browser test page after Capacitor's native bridge loads, so
// the host sees the Android WebView the bridge describes.
import { balebase, startBalebase } from "@balebase/app/balebase";
import { configureHost } from "@balebase/app/host";
import { capacitorHost } from "../src/host";

// As renderApp starts the app with the shell's host.
const host = capacitorHost("https://app.test");
configureHost(host);
startBalebase(host);

export const fetchApi = (input: RequestInfo | URL, init?: RequestInit) =>
  balebase().fetch(input, init);
export { saveNativeFile as saveFile } from "../src/saveFile";
