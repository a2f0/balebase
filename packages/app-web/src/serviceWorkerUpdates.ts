import { productName } from "@balebase/ui/brand";

export interface UpdateState {
  available: boolean;
  busy: boolean;
  error?: string;
}

/** Owns one tab's update consent; background checks never reload an editor. */
export class ServiceWorkerUpdates {
  #registration?: ServiceWorkerRegistration;
  #controller = navigator.serviceWorker.controller;
  #requested: ServiceWorker | undefined;
  #offered?: ServiceWorker;
  #busy = false;
  #disposed = false;
  #checking = false;
  #lastCheck = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #port?: MessagePort;
  #cleanup = new Set<() => void>();
  #notify: (state: UpdateState) => void;

  constructor(notify: (state: UpdateState) => void) {
    this.#notify = (state) => {
      if (!this.#disposed) notify(state);
    };
    this.#listen(navigator.serviceWorker, "controllerchange", this.#controlled);
    this.#listen(window, "online", this.#check);
    this.#listen(window, "focus", this.#check);
    this.#listen(window, "pageshow", this.#check);
    this.#listen(document, "visibilitychange", this.#check);
    const interval = setInterval(this.#check, 60 * 60 * 1000);
    this.#cleanup.add(() => clearInterval(interval));
    this.#checking = true;
    void this.#register().finally(() => {
      this.#checking = false;
    });
  }

  async #register() {
    try {
      const registration = await navigator.serviceWorker.register(
        "/offline-worker.js",
        { updateViaCache: "none" },
      );
      if (this.#disposed) return;
      this.#registration = registration;
      this.#lastCheck = Date.now();
      this.#listen(registration, "updatefound", this.#watchInstalling);
      this.#watchInstalling();
      this.#showWaiting();
    } catch {
      this.#lastCheck = 0;
      // Offline startup remains usable; the next online/focus event retries.
    }
  }

  #listen(target: EventTarget, event: string, listener: () => void) {
    target.addEventListener(event, listener);
    const stop = () => {
      target.removeEventListener(event, listener);
      this.#cleanup.delete(stop);
    };
    this.#cleanup.add(stop);
    return stop;
  }

  #watchInstalling = () => {
    const worker = this.#registration?.installing;
    if (!worker) return;
    const changed = () => {
      this.#showWaiting();
      if (worker.state === "installed" || worker.state === "redundant") stop();
    };
    const stop = this.#listen(worker, "statechange", changed);
    changed();
  };

  #showWaiting = () => {
    const waiting = this.#registration?.waiting;
    if (
      waiting &&
      this.#controller &&
      !this.#busy &&
      waiting !== this.#offered
    ) {
      this.#offered = waiting;
      this.#notify({ available: true, busy: false });
    }
  };

  #check = () => {
    this.#controlled();
    this.#showWaiting();
    if (
      this.#disposed ||
      !navigator.onLine ||
      document.visibilityState === "hidden" ||
      this.#checking ||
      Date.now() - this.#lastCheck < 60_000
    )
      return;
    this.#lastCheck = Date.now();
    this.#checking = true;
    const check = this.#registration
      ? this.#registration.update()
      : this.#register();
    void check
      .catch(() => {
        this.#lastCheck = 0;
      })
      .finally(() => {
        this.#checking = false;
      });
  };

  #controlled = () => {
    const controller = navigator.serviceWorker.controller;
    if (controller === this.#controller) return;
    const previous = this.#controller;
    this.#controller = controller;
    if (controller && controller === this.#requested) {
      this.dispose();
      window.location.reload();
    } else if (previous && controller) {
      // A restored tab or an external update must still ask before reloading.
      this.#notify({ available: true, busy: false });
    }
  };

  apply() {
    if (this.#disposed || this.#busy) return;
    if (!navigator.onLine) {
      this.#fail("Reconnect to the internet, then try updating again.", false);
      return;
    }
    const worker = this.#registration?.waiting;
    if (!worker) {
      window.location.reload();
      return;
    }
    this.#requested = worker;
    this.#busy = true;
    this.#notify({ available: true, busy: true });
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === "OTHER_TABS")
        this.#fail(
          `Save your work and close other ${productName} tabs or windows, then try again.`,
        );
      else if (event.data !== "ACTIVATING")
        this.#fail("The update could not start. Please try again.");
    };
    this.#timer = setTimeout(
      () =>
        this.#fail(
          "The update is taking longer than expected. This tab will reload when it is ready.",
          false,
        ),
      15_000,
    );
    try {
      worker.postMessage({ type: "ACTIVATE_UPDATE" }, [channel.port2]);
    } catch {
      channel.port2.close();
      this.#fail("The update could not start. Please try again.");
    }
  }

  #fail(error: string, forgetRequest = true) {
    clearTimeout(this.#timer);
    this.#port?.close();
    if (forgetRequest) this.#requested = undefined;
    this.#busy = false;
    this.#notify({ available: true, busy: false, error });
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#port?.close();
    for (const cleanup of this.#cleanup) cleanup();
    this.#cleanup.clear();
  }
}
