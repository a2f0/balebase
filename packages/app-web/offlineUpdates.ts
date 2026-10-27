/** Included in the generated classic worker, independent of browser-specific APIs. */
export const offlineUpdates = `
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
`;
