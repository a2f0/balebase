import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { installDom } from "../testing/dom";
import { AppButtonLink, AppLink } from "./AppLink";

const { clickLink, mount } = installDom({ url: "http://localhost:5173/" });
let container: HTMLElement;

async function render(element: ReactNode) {
  ({ container } = await mount(element));
  const link = container.querySelector<HTMLAnchorElement>("a");
  if (!link) throw new Error("No link rendered.");
  return link;
}

const browserClicks = [
  { metaKey: true },
  { ctrlKey: true },
  { shiftKey: true },
  { altKey: true },
  { button: 1 },
];

describe("app links", () => {
  it("opens a plain click in place and leaves other clicks to the browser", async () => {
    const paths: string[] = [];
    const link = await render(
      <AppLink
        aria-current="page"
        className="tab"
        href="/equipment/item%2F1"
        onNavigate={(path) => paths.push(path)}
      >
        Laptop
      </AppLink>,
    );
    expect(link.getAttribute("href")).toBe("/equipment/item%2F1");
    expect(link.className).toBe("tab");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.textContent).toBe("Laptop");

    for (const init of browserClicks) {
      expect([init, clickLink(link, init)]).toEqual([init, false]);
    }
    expect(paths).toEqual([]);

    expect(clickLink(link)).toBe(true);
    expect(paths).toEqual(["/equipment/item%2F1"]);
  });

  it("follows button-styled links the same way", async () => {
    const paths: string[] = [];
    const link = await render(
      <AppButtonLink
        href="/me"
        icon="arrowLeft"
        onNavigate={(path) => paths.push(path)}
        size="sm"
        variant="ghost"
      >
        Back
      </AppButtonLink>,
    );
    expect(link.getAttribute("href")).toBe("/me");
    expect(link.classList.contains("button")).toBe(true);
    expect(link.classList.contains("buttonSm")).toBe(true);

    for (const init of browserClicks) {
      expect(clickLink(link, init)).toBe(false);
    }
    expect(clickLink(link)).toBe(true);
    expect(paths).toEqual(["/me"]);
  });
});
