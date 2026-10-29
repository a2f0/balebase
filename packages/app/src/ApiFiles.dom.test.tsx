import {
  afterEach,
  beforeEach,
  expect,
  it,
  type Mock,
  mock,
  spyOn,
} from "bun:test";
import { act, type ReactNode } from "react";
import { ApiDownload } from "./ApiDownload";
import { ApiImage } from "./ApiImage";
import { configureHost } from "./host";
import * as saving from "./saveFile";
import { installDom } from "./testing/dom";

const {
  mount,
  respond,
  window: dom,
} = installDom({ url: "http://localhost:5173/audits" });
let container: HTMLElement;

async function render(element: ReactNode) {
  const view = await mount(element);
  container = view.container;
  return view;
}

let fetchMock: Mock<(url: URL, init?: RequestInit) => Promise<Response>>;
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
  fetchMock = mock<(url: URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockResolvedValue(new Response(new Uint8Array([0, 255, 1])));
  respond(fetchMock);
  save = spyOn(saving, "saveFile").mockResolvedValue(true);
  createUrl = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:native-image",
  );
  revokeUrl = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  configureHost({});
  save.mockRestore();
  createUrl.mockRestore();
  revokeUrl.mockRestore();
});

it("fetches protected native images and releases their local URL on unmount", async () => {
  const view = await render(
    <ApiImage alt="Private photo" src="https://api.test/image" />,
  );
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
  await view.unmount();
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
