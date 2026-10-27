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
  #disposed = false;
  #checking = false;
  #lastCheck = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #port?: MessagePort;
  #cleanup: (() => void)[] = [];
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
    this.#cleanup.push(() => clearInterval(interval));
    void this.#register();
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
    this.#cleanup.push(() => target.removeEventListener(event, listener));
  }

  #watchInstalling = () => {
    const worker = this.#registration?.installing;
    if (worker) this.#listen(worker, "statechange", this.#showWaiting);
  };

  #showWaiting = () => {
    if (this.#registration?.waiting && this.#controller && !this.#requested)
      this.#notify({ available: true, busy: false });
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
    if (this.#disposed || this.#requested) return;
    if (!navigator.onLine) {
      this.#fail("Reconnect to the internet, then try updating again.");
      return;
    }
    const worker = this.#registration?.waiting;
    if (!worker) {
      window.location.reload();
      return;
    }
    this.#requested = worker;
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
      () => this.#fail("The update did not finish. Please try again."),
      15_000,
    );
    try {
      worker.postMessage({ type: "ACTIVATE_UPDATE" }, [channel.port2]);
    } catch {
      channel.port2.close();
      this.#fail("The update could not start. Please try again.");
    }
  }

  #fail(error: string) {
    clearTimeout(this.#timer);
    this.#port?.close();
    this.#requested = undefined;
    this.#notify({ available: true, busy: false, error });
  }

  dispose() {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#port?.close();
    for (const cleanup of this.#cleanup) cleanup();
  }
}
