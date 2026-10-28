import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { Business } from "@balebase/validators/businesses";
import { act } from "react";
import { Businesses } from "./Businesses";
import { installDom } from "./testing/dom";

// Mounts the real page in happy-dom so effects run: the add form folds away
// and focus moves the way a keyboard user would experience it.
const {
  click,
  fill,
  mount,
  queryButton,
  respond,
  settle,
  stubClipboard,
  window: dom,
} = installDom({ url: "http://localhost:5173/businesses" });

function business(id: string, name: string): Business {
  return {
    city: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    duns: null,
    ein: null,
    id,
    incorporationDate: null,
    name,
    state: null,
    streetAddress: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    zip: null,
  };
}

/** Serves the listing, and answers each create with `createResponse`. */
function stubApi(
  businesses: Business[],
  createResponse: (name: string) => Response,
  canManage = true,
) {
  const created: string[] = [];
  respond(async (_url, init) => {
    if ((init?.method ?? "GET") === "GET") {
      return Response.json({ businesses, canManage });
    }
    const { name } = JSON.parse(String(init?.body)) as { name: string };
    created.push(name);
    return createResponse(name);
  });
  return created;
}

async function mountPage(
  onNavigate: (pathname: string) => void = () => {},
  pathname = "/businesses",
) {
  const { container } = await mount(
    <>
      <Businesses onNavigate={onNavigate} pathname={pathname} />
      <DialogHost />
    </>,
  );
  await settle();
  return page(container);
}

function page(container: HTMLElement) {
  const form = () =>
    [...container.querySelectorAll("form")].find((element) =>
      element.textContent?.includes("Add a business"),
    );
  return {
    addButton: () =>
      queryButton("Add business", container.querySelector(".pageActions")),
    cancelButton: () => queryButton("Cancel", form()),
    form,
    labelled: (label: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[aria-label="${label}"]`,
      ),
    nameField: () =>
      form()?.querySelector<HTMLInputElement>(
        'input[placeholder="Acme, Inc."]',
      ) ?? null,
    rows: () => container.querySelectorAll(".rowList > li").length,
    row: (index = 0) =>
      container.querySelectorAll<HTMLElement>(".rowList > li")[index],
    submitButton: () =>
      form()?.querySelector<HTMLButtonElement>('button[type="submit"]'),
    text: () => container.textContent ?? "",
  };
}

describe("adding a business, mounted", () => {
  it("opens the form on arrival for the first business without moving focus", async () => {
    stubApi([], (name) => Response.json({ business: business("b1", name) }));
    const view = await mountPage();
    expect(view.form()).toBeTruthy();
    expect(view.addButton()).toBeNull();
    expect(view.cancelButton()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("folds the form away after the first business and focuses Add", async () => {
    const created = stubApi([], (name) =>
      Response.json({ business: business("b1", name) }),
    );
    const view = await mountPage();
    await fill(view.nameField(), "Acme, Inc.");
    await click(view.submitButton());

    expect(created).toEqual(["Acme, Inc."]);
    expect(view.form()).toBeUndefined();
    expect(view.rows()).toBe(1);
    expect(view.text()).toContain("Business added.");
    expect(document.activeElement).toBe(view.addButton());
  });

  it("opens on demand into the name field, and cancel returns focus", async () => {
    stubApi([business("b1", "Acme, Inc.")], (name) =>
      Response.json({ business: business("b2", name) }),
    );
    const view = await mountPage();
    expect(view.form()).toBeUndefined();

    await click(view.addButton());
    expect(view.form()).toBeTruthy();
    expect(document.activeElement).toBe(view.nameField());

    await click(view.cancelButton());
    expect(view.form()).toBeUndefined();
    expect(document.activeElement).toBe(view.addButton());
  });

  it("adds on demand, then folds away and focuses Add", async () => {
    const created = stubApi([business("b1", "Acme, Inc.")], (name) =>
      Response.json({ business: business("b2", name) }),
    );
    const view = await mountPage();
    await click(view.addButton());
    await fill(view.nameField(), "Beta LLC");
    await click(view.submitButton());

    expect(created).toEqual(["Beta LLC"]);
    expect(view.form()).toBeUndefined();
    expect(view.rows()).toBe(2);
    expect(document.activeElement).toBe(view.addButton());
  });

  it("keeps the form and its values open when an add fails", async () => {
    stubApi([business("b1", "Acme, Inc.")], () =>
      Response.json({ error: "Name taken." }, { status: 409 }),
    );
    const view = await mountPage();
    await click(view.addButton());
    await fill(view.nameField(), "Beta LLC");
    await click(view.submitButton());

    expect(view.form()).toBeTruthy();
    expect(view.nameField()?.value).toBe("Beta LLC");
    expect(view.text()).toContain("Name taken.");
    expect(view.rows()).toBe(1);
  });
});

async function openContextMenu(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy();
  const event = new dom.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 120,
    clientY: 180,
  });
  await act(async () => element?.dispatchEvent(event as never));
  expect(event.defaultPrevented).toBe(true);
  return document.querySelector<HTMLButtonElement>('[role="menuitem"]');
}

describe("copying a business EIN", () => {
  it("copies the displayed EIN without navigating and announces success", async () => {
    const copied: string[] = [];
    const navigations: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    stubApi([{ ...business("b1", "Acme, Inc."), ein: "123456789" }], () =>
      Response.json({}),
    );
    const view = await mountPage((pathname) => navigations.push(pathname));
    const link = view.row()?.querySelector<HTMLAnchorElement>("a") ?? null;
    const item = await openContextMenu(link);
    expect(item?.textContent).toBe("Copy EIN");
    expect(document.activeElement).toBe(item);
    await click(item);
    expect(copied).toEqual(["12-3456789"]);
    expect(navigations).toEqual([]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(view.text()).toContain("EIN copied.");
    expect(document.activeElement).toBe(link);
    await click(link);
    expect(navigations).toEqual(["/businesses/b1"]);
  });

  it("disables Copy EIN when a business has no EIN", async () => {
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    stubApi([business("b1", "Acme, Inc.")], () => Response.json({}));
    const view = await mountPage();
    const item = await openContextMenu(view.row());
    expect(item?.disabled).toBe(true);
    await click(item);
    expect(copied).toEqual([]);
    expect(view.text()).not.toContain("EIN copied.");
  });

  it("offers copying to read-only members and switches to the business last clicked", async () => {
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    stubApi(
      [
        { ...business("b1", "Acme, Inc."), ein: "123456789" },
        { ...business("b2", "Beta LLC"), ein: "987654321" },
      ],
      () => Response.json({}),
      false,
    );
    const view = await mountPage();
    await openContextMenu(view.row());
    const item = await openContextMenu(view.row(1));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(
      document.querySelector('[role="menu"]')?.getAttribute("aria-label"),
    ).toBe("Actions for Beta LLC");
    await click(item);
    expect(copied).toEqual(["98-7654321"]);
  });

  it("reports clipboard rejection and can retry successfully", async () => {
    stubClipboard(async () => {
      throw new Error("Permission denied");
    });
    stubApi([{ ...business("b1", "Acme, Inc."), ein: "123456789" }], () =>
      Response.json({}),
    );
    const view = await mountPage();
    await click(await openContextMenu(view.row()));
    expect(view.text()).toContain("Could not copy the EIN. Please try again.");
    expect(view.text()).not.toContain("EIN copied.");
    stubClipboard(async () => {});
    await click(await openContextMenu(view.row()));
    expect(view.text()).not.toContain("Could not copy the EIN");
    expect(view.text()).toContain("EIN copied.");
  });

  it("reports when the Clipboard API is unavailable", async () => {
    stubClipboard();
    stubApi([{ ...business("b1", "Acme, Inc."), ein: "123456789" }], () =>
      Response.json({}),
    );
    const view = await mountPage();
    await click(await openContextMenu(view.row()));
    expect(view.text()).toContain("Could not copy the EIN. Please try again.");
  });
});

describe("a business DUNS number", () => {
  it("is sent with a new business and shown on its row", async () => {
    stubApi([], (name) =>
      Response.json({
        business: { ...business("b1", name), duns: "123456789" },
      }),
    );
    const served = globalThis.fetch;
    const posted: unknown[] = [];
    respond(async (url, init) => {
      if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
      return served(url, init);
    });
    const view = await mountPage();
    await fill(view.nameField(), "Acme, Inc.");
    await fill(
      view
        .form()
        ?.querySelector<HTMLInputElement>('input[placeholder="12-345-6789"]'),
      "12-345-6789",
    );
    await click(view.submitButton());

    expect(posted).toEqual([
      expect.objectContaining({ duns: "12-345-6789", name: "Acme, Inc." }),
    ]);
    expect(view.row()?.textContent).toContain(
      "EIN not provided · DUNS 12-345-6789",
    );
  });

  it("is copied grouped from the menu, after a disabled Copy EIN", async () => {
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    stubApi([{ ...business("b1", "Acme, Inc."), duns: "123456789" }], () =>
      Response.json({}),
    );
    const view = await mountPage();
    await openContextMenu(view.row());
    const [copyEin, copyDuns] =
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(copyEin?.disabled).toBe(true);
    expect(copyDuns?.textContent).toBe("Copy DUNS number");
    expect(document.activeElement).toBe(copyDuns ?? null);
    await click(copyDuns);
    expect(copied).toEqual(["12-345-6789"]);
    expect(view.text()).toContain("DUNS number copied.");
  });

  it("names the DUNS number when copying fails", async () => {
    stubClipboard(async () => {
      throw new Error("Permission denied");
    });
    stubApi([{ ...business("b1", "Acme, Inc."), duns: "123456789" }], () =>
      Response.json({}),
    );
    const view = await mountPage();
    await openContextMenu(view.row());
    await click(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1],
    );
    expect(view.text()).toContain(
      "Could not copy the DUNS number. Please try again.",
    );
  });
});

describe("copying identifiers on the business detail page", () => {
  async function mountDetail(detail: Business) {
    respond(async () => Response.json({ business: detail, canManage: false }));
    return mountPage(undefined, `/businesses/${detail.id}`);
  }

  it("copies the displayed EIN and DUNS number and announces each", async () => {
    const copied: string[] = [];
    stubClipboard(async (value) => {
      copied.push(value);
    });
    const view = await mountDetail({
      ...business("b1", "Acme, Inc."),
      duns: "123456789",
      ein: "123456789",
    });
    await click(view.labelled("Copy EIN"));
    expect(copied).toEqual(["12-3456789"]);
    expect(view.text()).toContain("EIN copied.");

    await click(view.labelled("Copy DUNS number"));
    expect(copied).toEqual(["12-3456789", "12-345-6789"]);
    expect(view.text()).toContain("DUNS number copied.");
    expect(view.text()).not.toContain("EIN copied.");
  });

  it("offers no copy button for an identifier that is not provided", async () => {
    const view = await mountDetail({
      ...business("b1", "Acme, Inc."),
      duns: "123456789",
    });
    expect(view.text()).toContain("EINNot provided");
    expect(view.labelled("Copy EIN")).toBeNull();
    expect(view.labelled("Copy DUNS number")).toBeTruthy();
  });

  it("reports a clipboard failure and clears it on a successful retry", async () => {
    stubClipboard(async () => {
      throw new Error("Permission denied");
    });
    const view = await mountDetail({
      ...business("b1", "Acme, Inc."),
      ein: "123456789",
    });
    await click(view.labelled("Copy EIN"));
    expect(view.text()).toContain("Could not copy the EIN. Please try again.");
    expect(view.text()).toContain("12-3456789");

    stubClipboard(async () => {});
    await click(view.labelled("Copy EIN"));
    expect(view.text()).not.toContain("Could not copy the EIN");
    expect(view.text()).toContain("EIN copied.");
  });
});

describe("editing a business from its detail page", () => {
  const acme = {
    ...business("b1", "Acme, Inc."),
    duns: "123456789",
    ein: "123456789",
  };

  /** Serves the detail, and answers each save with `patch`. */
  async function mountEditable(
    patch: () => Response = () => Response.json({ business: acme }),
    canManage = true,
  ) {
    const patches: unknown[] = [];
    respond(async (_url, init) => {
      if (init?.method !== "PATCH") {
        return Response.json({ business: acme, canManage });
      }
      patches.push(JSON.parse(String(init.body)));
      return patch();
    });
    const view = await mountPage(undefined, `/businesses/${acme.id}`);
    return { patches, view };
  }

  const named = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    ) ?? null;
  const editor = () =>
    [...document.querySelectorAll("form")].find((element) =>
      element.textContent?.includes("Edit business"),
    );
  const field = (placeholder: string) =>
    editor()?.querySelector<HTMLInputElement>(
      `input[placeholder="${placeholder}"]`,
    );

  it("opens a filled editor, saves, and hands focus back to Edit", async () => {
    const { patches, view } = await mountEditable(() =>
      Response.json({ business: { ...acme, name: "Acme Holdings" } }),
    );
    await click(named("Edit"));
    expect(editor()).toBeTruthy();
    expect(named("Edit")).toBeNull();
    expect(document.activeElement).toBe(field("Acme, Inc.") ?? null);
    expect(field("12-3456789")?.value).toBe("12-3456789");
    expect(field("12-345-6789")?.value).toBe("12-345-6789");

    await fill(field("Acme, Inc."), "Acme Holdings");
    await click(named("Save changes"));
    expect(patches).toEqual([
      expect.objectContaining({
        duns: "12-345-6789",
        ein: "12-3456789",
        name: "Acme Holdings",
      }),
    ]);
    expect(editor()).toBeUndefined();
    expect(view.text()).toContain("Business updated.");
    expect(document.querySelector("h1")?.textContent).toBe("Acme Holdings");
    expect(document.activeElement).toBe(named("Edit"));
  });

  it("discards edits on cancel and hands focus back to Edit", async () => {
    const { patches, view } = await mountEditable();
    await click(named("Edit"));
    await fill(field("Acme, Inc."), "Changed");
    await click(named("Cancel"));
    expect(patches).toEqual([]);
    expect(editor()).toBeUndefined();
    expect(view.text()).not.toContain("Changed");
    expect(document.activeElement).toBe(named("Edit"));
  });

  it("keeps the editor and its values open when saving fails", async () => {
    const { view } = await mountEditable(() =>
      Response.json(
        { error: "A business with that EIN already exists." },
        { status: 409 },
      ),
    );
    await click(named("Edit"));
    await fill(field("Acme, Inc."), "Acme Holdings");
    await click(named("Save changes"));
    expect(editor()).toBeTruthy();
    expect(field("Acme, Inc.")?.value).toBe("Acme Holdings");
    expect(view.text()).toContain("A business with that EIN already exists.");
    expect(named("Save changes")?.disabled).toBe(false);
  });

  it("offers no Edit button to read-only members", async () => {
    const { view } = await mountEditable(undefined, false);
    expect(view.text()).toContain("Acme, Inc.");
    expect(named("Edit")).toBeNull();
  });
});

describe("deleting a business", () => {
  /** Answers the open dialog with the button labelled `label`. */
  async function answer(label: string) {
    const dialog = document.querySelector("dialog[open]");
    const choice = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (element) => element.textContent?.trim() === label,
    );
    await click(choice);
  }

  it("asks in the app's dialog, and deletes only once confirmed", async () => {
    const deletes: string[] = [];
    respond(async (url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(url.href);
        return new Response(null, { status: 204 });
      }
      return Response.json({
        businesses: [business("b1", "Acme, Inc.")],
        canManage: true,
      });
    });
    const view = await mountPage();
    const remove = () =>
      [...(view.row()?.querySelectorAll("button") ?? [])].find(
        (element) => element.textContent?.trim() === "Delete",
      );

    await click(remove());
    const dialog = document.querySelector("dialog[open]");
    expect(dialog?.textContent).toContain("Delete Acme, Inc.?");
    expect(dialog?.textContent).toContain("This can't be undone.");
    await answer("Cancel");
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(deletes).toEqual([]);
    expect(view.rows()).toBe(1);

    await click(remove());
    await answer("Delete business");
    expect(deletes).toEqual([expect.stringContaining("/api/businesses/b1")]);
    expect(view.rows()).toBe(0);
    expect(view.text()).toContain("Business deleted.");
  });
});
