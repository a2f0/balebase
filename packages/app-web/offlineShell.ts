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
const cachedShell = () => caches.open(cacheName).then(cache => cache.match("/index.html"));
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
    event.respondWith(fetch(request).then(async response => response.status >= 400 ? (await cachedShell()) || response : response).catch(cachedShell));
  } else if (assets.includes(url.pathname) && !url.search) {
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
`;
}
