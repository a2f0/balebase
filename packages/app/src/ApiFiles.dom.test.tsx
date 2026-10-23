import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  type Mock,
  spyOn,
} from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { ApiDownload } from "./ApiDownload";
import { ApiImage } from "./ApiImage";
import { configureHost } from "./host";
import * as saving from "./saveFile";

const dom = new Window({ url: "http://localhost:5173/audits" });
const domGlobals = {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  navigator: dom.navigator,
  Node: dom.Node,
  window: dom,
};
const saved = new Map<string, PropertyDescriptor | undefined>();
let createRoot: (container: Element) => Root;
let root: Root | undefined;
let container: HTMLElement;

beforeAll(async () => {
  for (const [key, value] of Object.entries(domGlobals)) {
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

async function render(element: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

let fetchMock: Mock<typeof fetch>;
let save: Mock<typeof saving.saveFile>;
let createUrl: Mock<typeof URL.createObjectURL>;
let revokeUrl: Mock<typeof URL.revokeObjectURL>;
beforeEach(() => {
  configureHost({
    native: {
      appUrl: "https://app.test",
      origin: "https://localhost",
      saveFile: async () => true,
      savePassword: async () => {},
    },
  });
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new Uint8Array([0, 255, 1])),
  );
  save = spyOn(saving, "saveFile").mockResolvedValue(true);
  createUrl = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:native-image",
  );
  revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  configureHost({});
  fetchMock.mockRestore();
  save.mockRestore();
  createUrl.mockRestore();
  revokeUrl.mockRestore();
});

it("fetches protected native images and releases their local URL on unmount", async () => {
  await render(<ApiImage alt="Private photo" src="https://api.test/image" />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "blob:native-image",
  );
  expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  const imageBlob = createUrl.mock.calls[0]?.[0];
  if (!(imageBlob instanceof Blob))
    throw new Error("Expected downloaded image bytes");
  expect(await imageBlob.arrayBuffer()).toEqual(
    new Uint8Array([0, 255, 1]).buffer,
  );
  await act(async () => root?.unmount());
  root = undefined;
  expect(revokeUrl).toHaveBeenCalledWith("blob:native-image");
});

it("shares downloaded bytes on native, blocks duplicate taps, and shows failures", async () => {
  await render(
    <ApiDownload href="https://api.test/file" filename="private.bin">
      Download
    </ApiDownload>,
  );
  const link = container.querySelector("a");
  const click = () => {
    const event = new dom.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link?.dispatchEvent(event as unknown as Event);
    expect(event.defaultPrevented).toBe(true);
  };
  await act(async () => {
    click();
    click();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  expect(save.mock.calls[0]?.[1]).toBe("private.bin");
  expect(await save.mock.calls[0]?.[0].arrayBuffer()).toEqual(
    new Uint8Array([0, 255, 1]).buffer,
  );
  fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
  await act(async () => click());
  expect(container.textContent).toContain("Could not download the file");
  expect(save).toHaveBeenCalledTimes(1);
});

it("retains direct image and download URLs on the web without fetching eagerly", async () => {
  configureHost({});
  await render(
    <>
      <ApiImage src="https://api.test/image" alt="Photo" />
      <ApiDownload href="https://api.test/file" filename="file.bin">
        Download
      </ApiDownload>
    </>,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://api.test/image",
  );
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://api.test/file",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
