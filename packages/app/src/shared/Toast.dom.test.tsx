import { expect, it } from "bun:test";
import { Toast, ToastProvider } from "@balebase/ui/react";
import { act, StrictMode, useState } from "react";
import { installDom } from "../testing/dom";

const { mount } = installDom();

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
  const view = await mount(
    <StrictMode>
      <ToastProvider>
        <Feedback />
      </ToastProvider>
    </StrictMode>,
  );

  const region = document.querySelector('[aria-label="Notifications"]');
  expect(region?.parentElement).toBe(document.body);
  expect(region?.querySelectorAll(".toast")).toHaveLength(2);
  expect(view.container.textContent).toBe("Page content");
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

  await view.unmount();
  expect(document.querySelector('[aria-label="Notifications"]')).toBeNull();
});
