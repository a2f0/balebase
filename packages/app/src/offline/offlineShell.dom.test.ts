import { afterEach, expect, it } from "bun:test";
import { holdTimers, installDom } from "../testing/dom";
import { waitForOfflineShell } from "./offlineShell";

const { window } = installDom({ url: "http://localhost:5173/" });

/** Gives the page a service worker container whose `ready` is `ready`. */
function serviceWorkers(ready: Promise<unknown>) {
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { ready },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window.navigator, "serviceWorker");
});

it("rejects at once in a browser without service workers", async () => {
  expect("serviceWorker" in navigator).toBe(false);
  await expect(waitForOfflineShell()).rejects.toThrow(
    "Offline reopening requires a supported browser with service workers enabled.",
  );
});

it("resolves once the service worker is active, which the 15 seconds cannot undo", async () => {
  using timers = holdTimers(15_000);
  serviceWorkers(Promise.resolve());
  await expect(waitForOfflineShell()).resolves.toBeUndefined();
  let late = false;
  void waitForOfflineShell().catch(() => {
    late = true;
  });
  // The service worker answers first; the 15 seconds pass after.
  await Bun.sleep(0);
  await timers.fire();
  expect(late).toBe(false);
});

it("rejects with what kept the service worker from activating", async () => {
  const cause = new Error("Registration failed");
  serviceWorkers(Promise.reject(cause));
  await expect(waitForOfflineShell()).rejects.toBe(cause);
});

it("gives up after 15 seconds of downloading", async () => {
  using timers = holdTimers(15_000);
  serviceWorkers(new Promise(() => {}));
  const waiting = waitForOfflineShell();
  let outcome: unknown;
  waiting.catch((cause: unknown) => {
    outcome = cause;
  });
  await timers.fire();
  expect(String(outcome)).toContain(
    "The app is still downloading for offline use. Stay connected and try again.",
  );
});
