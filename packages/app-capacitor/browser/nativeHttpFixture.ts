// Bundled into the browser test page after Capacitor's native bridge loads, so
// the host sees the Android WebView the bridge describes.
import { configureHost } from "@balebase/app/host";
import { capacitorHost } from "../src/host";

configureHost(capacitorHost("https://app.test"));

export { fetchApi } from "@balebase/app/apiVersion";
export { saveNativeFile as saveFile } from "../src/saveFile";
