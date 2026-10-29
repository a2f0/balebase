import { describe, expect, it } from "bun:test";
import { ApiError } from "@balebase/api-client";
import type { ReactNode } from "react";
import {
  blockingSeatRequirement,
  OrganizationSeatRequired,
} from "../organizations/OrganizationSeatRequired";
import { errorNotice } from "../shared/errors";
import { installDom } from "../testing/dom";
import { ErrorToast } from "./ErrorToast";

const { clickLink, render: renderInDom } = installDom({
  url: "http://localhost:5173/audits",
});
let container: HTMLElement;

async function render(element: ReactNode) {
  ({ container } = await renderInDom(element));
}

function billingLink() {
  return container.querySelector<HTMLAnchorElement>("a");
}

describe("billing links", () => {
  it("links an upgrade error to Billing without a page load", async () => {
    const paths: string[] = [];
    const limit = new ApiError(new Response(null, { status: 409 }), {
      code: "UPGRADE_REQUIRED",
      error: "The Free plan is limited to 5 form templates.",
    });
    await render(
      <ErrorToast
        error={errorNotice(limit, "fallback")}
        onNavigate={(path) => paths.push(path)}
      />,
    );

    const link = billingLink();
    expect(container.textContent).toContain(limit.message);
    expect(link?.textContent).toBe("Go to Billing");
    expect(link?.getAttribute("href")).toBe("/organization/billing");
    expect(link && clickLink(link)).toBe(true);
    expect(paths).toEqual(["/organization/billing"]);
    expect(link && clickLink(link, { metaKey: true })).toBe(false);
    expect(paths).toHaveLength(1);
  });

  it("leaves other errors without a link", async () => {
    await render(
      <ErrorToast
        error={errorNotice(new Error("Template not found."), "fallback")}
        onNavigate={() => {}}
      />,
    );
    expect(container.textContent).toContain("Template not found.");
    expect(billingLink()).toBeNull();
    expect(errorNotice("not an error", "fallback")).toEqual({
      message: "fallback",
      upgrade: false,
    });
  });

  it("offers Billing only to owners who can upgrade", async () => {
    const paths: string[] = [];
    await render(
      <OrganizationSeatRequired
        onNavigate={(path) => paths.push(path)}
        requirement="upgrade"
      />,
    );
    expect(container.textContent).toContain("Upgrade to Pro");
    const link = billingLink();
    expect(link && clickLink(link)).toBe(true);
    expect(paths).toEqual(["/organization/billing"]);

    await render(
      <OrganizationSeatRequired
        onNavigate={() => {}}
        requirement="ask-owner"
      />,
    );
    expect(container.textContent).toContain("Ask an owner");
    expect(billingLink()).toBeNull();
  });

  it("keeps Billing reachable only for owners who can upgrade", () => {
    expect(blockingSeatRequirement("upgrade", "/organization/billing")).toBe(
      undefined,
    );
    expect(blockingSeatRequirement("upgrade", "/audits")).toBe("upgrade");
    expect(blockingSeatRequirement("ask-owner", "/organization/billing")).toBe(
      "ask-owner",
    );
    expect(blockingSeatRequirement(undefined, "/audits")).toBeUndefined();
  });
});
