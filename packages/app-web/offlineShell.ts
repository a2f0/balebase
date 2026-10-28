import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** Cache only the public app shell; authenticated API responses never enter Cache Storage. */
export function offlineShell(): Plugin {
  return {
    name: "balebase-offline-shell",
    apply: "build",
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((name) =>
        /\.(js|css|woff2?|svg|png|webp|ico)$/.test(name),
      );
      const hash = createHash("sha256");
      for (const [name, output] of Object.entries(bundle).sort()) {
        hash.update(name);
        hash.update(output.type === "chunk" ? output.code : output.source);
      }
      const version = hash.digest("hex").slice(0, 16);
      const assets = ["/index.html", ...files.map((name) => `/${name}`)];
      this.emitFile({
        type: "asset",
        fileName: "offline-worker.js",
        source: workerSource(version, assets),
      });
    },
  };
}

function workerSource(version: string, assets: string[]) {
  return `const cacheName = ${JSON.stringify(`balebase-shell-${version}`)};
const assets = ${JSON.stringify(assets)};

self.addEventListener("message", event => {
  if (event.data?.type !== "ACTIVATE_UPDATE" || !event.source?.id || !event.ports[0]) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appWindows = windows.filter(client => client.url.startsWith(self.registration.scope));
    // Waiting workers control no clients, so includeUncontrolled is essential.
    // Refuse when another open tab may contain unsaved work. A new tab can
    // still open between this snapshot and activation; it never auto-reloads.
    if (appWindows.some(client => client.id !== event.source.id)) {
      event.ports[0].postMessage("OTHER_TABS");
      return;
    }
    event.ports[0].postMessage("ACTIVATING");
    await self.skipWaiting();
  })().catch(() => event.ports[0].postMessage("FAILED")));
});

const cachedShell = async () => {
  const cache = await caches.open(cacheName);
  const response = await cache.match("/index.html");
  if (!response?.redirected) return response;
  // Cloudflare redirects /index.html to /. Navigation requests cannot reuse
  // a followed redirect, so return the same public HTML without its URL history.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(assets)));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("balebase-shell-") && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Serve the active worker's complete shell version online and offline.
    event.respondWith(cachedShell().then(cached => cached || fetch(request)));
  } else if (assets.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
`;
}
