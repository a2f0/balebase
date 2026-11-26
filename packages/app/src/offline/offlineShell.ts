/**
 * Resolves once the service worker that reopens the app without a
 * connection is active; rejects without one, or after 15 seconds.
 */
export function waitForOfflineShell() {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "Offline reopening requires a supported browser with service workers enabled.",
    );
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        reject(
          new Error(
            "The app is still downloading for offline use. Stay connected and try again.",
          ),
        ),
      15_000,
    );
    void navigator.serviceWorker.ready.then(
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
