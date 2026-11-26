// Bundled into the browser test page after Capacitor's native bridge loads, so
// the host sees the Android WebView the bridge describes.
import { balebase } from "@balebase/app/balebase";
import { configureHost } from "@balebase/app/host";
import { capacitorHost } from "../src/host";

configureHost(capacitorHost("https://app.test"));

export const fetchApi = (input: RequestInfo | URL, init?: RequestInit) =>
  balebase().fetch(input, init);
export { saveNativeFile as saveFile } from "../src/saveFile";
