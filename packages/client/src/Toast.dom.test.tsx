import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { Toast, ToastProvider } from "@tearleads/ui/react";
import { Window } from "happy-dom";
import { act, StrictMode, useState } from "react";
import type { Root } from "react-dom/client";

const dom = new Window();
const globals = {
  document: dom.document,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function Feedback() {
  const [visible, setVisible] = useState(true);
  return (
    <section style={{ transform: "translateZ(0)", overflow: "hidden" }}>
      <p>Page content</p>
      {visible && (
        <Toast
          actions={
            <button onClick={() => setVisible(false)} type="button">
              Dismiss success
            </button>
          }
          tone="success"
        >
          Address copied.
        </Toast>
      )}
      <Toast tone="danger">Upload failed. Please try again.</Toast>
    </section>
  );
}

it("shares one viewport outside page containers and cleans up dismissed notices", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <StrictMode>
        <ToastProvider>
          <Feedback />
        </ToastProvider>
      </StrictMode>,
    ),
  );

  const region = document.querySelector('[aria-label="Notifications"]');
  expect(region?.parentElement).toBe(document.body);
  expect(region?.querySelectorAll(".toast")).toHaveLength(2);
  expect(container.textContent).toBe("Page content");
  expect(region?.querySelector('[role="status"]')?.textContent).toContain(
    "Address copied.",
  );
  expect(region?.querySelector('[role="alert"]')?.textContent).toContain(
    "Upload failed.",
  );
  await act(async () =>
    region?.querySelector<HTMLButtonElement>("button")?.click(),
  );
  expect(region?.querySelectorAll(".toast")).toHaveLength(1);
  expect(region?.textContent).not.toContain("Address copied.");
  expect(region?.textContent).toContain("Upload failed.");

  await act(async () => root?.unmount());
  root = undefined;
  expect(document.querySelector('[aria-label="Notifications"]')).toBeNull();
});
