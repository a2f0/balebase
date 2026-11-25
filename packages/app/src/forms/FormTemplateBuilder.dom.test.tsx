import { beforeAll, describe, expect, it } from "bun:test";
import type { FormTemplate } from "@balebase/validators/forms";
import { act } from "react";
import { installDom } from "../testing/dom";

const {
  mount,
  respond,
  settle,
  window: dom,
} = installDom({
  url: "http://localhost:5173/forms/templates/t1",
  globals: (window) => ({
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  }),
});
let FormTemplateBuilder: typeof import("./FormTemplateBuilder").FormTemplateBuilder;
let container: HTMLElement;

beforeAll(async () => {
  ({ FormTemplateBuilder } = await import("./FormTemplateBuilder"));
});

function question(id: string, prompt: string) {
  return { id, prompt, required: true, responseType: "check" as const };
}

const template: FormTemplate = {
  createdAt: "2026-10-01T09:00:00.000Z",
  currentVersion: 1,
  definition: {
    sections: [
      {
        id: "s1",
        items: [
          question("q1", "First"),
          question("q2", "Second"),
          question("q3", "Third"),
        ],
        title: "Kitchen",
      },
      { id: "s2", items: [question("q4", "Other")], title: "Storage" },
    ],
    version: 1,
  },
  description: "",
  id: "t1",
  name: "Opening checklist",
  savedAt: "2026-10-01T09:00:00.000Z",
  savedBy: { email: "olivia@example.com", id: "u1", name: "Olivia" },
  scope: "organization",
  status: "draft",
  updatedAt: "2026-10-01T09:00:00.000Z",
  version: 1,
};

const projectWrites: string[] = [];
let projectTemplates = new Set(["clinic"]);
/** Whether the served template can be turned on for projects. */
let templateAvailable = true;

/**
 * Serves the template and its projects; a save echoes back what was sent, and
 * turning the template on or off for a project is recorded.
 */
function stubApi(available = true) {
  const saves: Array<{ definition: FormTemplate["definition"] }> = [];
  projectWrites.length = 0;
  projectTemplates = new Set(["clinic"]);
  templateAvailable = available;
  respond(async (url, init) => {
    if (url.pathname === "/api/projects/templates/t1")
      return Response.json({
        available: templateAvailable,
        canManage: true,
        projects: [
          { id: "annex", name: "Annex" },
          { id: "clinic", name: "Clinic" },
        ].map((project) => ({
          ...project,
          enabled: projectTemplates.has(project.id),
        })),
      });
    const projectTemplate = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/templates\/t1$/,
    );
    if (projectTemplate?.[1]) {
      projectWrites.push(`${init?.method} ${url.pathname}`);
      if (init?.method === "PUT") projectTemplates.add(projectTemplate[1]);
      else projectTemplates.delete(projectTemplate[1]);
      return Response.json({ project: {} });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        definition: FormTemplate["definition"];
      };
      saves.push(body);
      if ((body as { status?: string }).status === "published")
        templateAvailable = true;
      return Response.json({
        template: { ...template, ...body, currentVersion: 2, version: 2 },
      });
    }
    if (url.pathname.endsWith("/templates/t1")) {
      return Response.json({ template });
    }
    if (url.pathname.endsWith("/versions")) {
      return Response.json({ versions: [] });
    }
    return Response.json({ events: [], nextCursor: null });
  });
  return saves;
}

async function render(canPublish = false) {
  ({ container } = await mount(
    <FormTemplateBuilder
      canPublish={canPublish}
      id="t1"
      onNavigate={() => {}}
    />,
  ));
  await settle(30);
}

const sections = () => [
  ...container.querySelectorAll<HTMLElement>(".formSectionCard"),
];
const sectionTitles = () =>
  sections().map(
    (section) =>
      section.querySelector<HTMLInputElement>(".formSectionTitle")?.value,
  );
const prompts = (sectionIndex = 0) =>
  [
    ...(sections()[sectionIndex]?.querySelectorAll<HTMLTextAreaElement>(
      ".formQuestionPrompt",
    ) ?? []),
  ].map((field) => field.value);
const questions = (sectionIndex = 0) => [
  ...(sections()[sectionIndex]?.querySelectorAll<HTMLElement>(
    ".formQuestion",
  ) ?? []),
];
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );

async function press(element: Element | null | undefined, key: string) {
  await act(async () => {
    element?.dispatchEvent(
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }) as never,
    );
  });
  await settle(30);
}

async function pointer(
  element: Element | null | undefined,
  type: "pointercancel" | "pointerdown" | "pointermove" | "pointerup",
  clientY: number,
  pointerId = 1,
) {
  await act(async () => {
    element?.dispatchEvent(
      new dom.PointerEvent(type, {
        bubbles: true,
        button: 0,
        cancelable: true,
        clientY,
        pointerId,
      }) as never,
    );
  });
}

describe("organization template publication", () => {
  it("lets managers publish a draft with the editor's changes", async () => {
    const saves = stubApi();
    await render(true);
    const header = () => container.querySelector(".formVersionControls");
    expect(header()?.textContent).toContain("Draft");
    const publish = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Publish");
    await act(async () => publish?.click());
    await settle(30);
    expect(saves).toEqual([
      expect.objectContaining({
        expectedCurrentVersion: 1,
        status: "published",
      }),
    ]);
    expect(container.textContent).toContain("Template published.");
    expect(header()?.textContent).toContain("Published");
    expect(header()?.textContent).toContain("Unpublish");
  });

  it("holds the template still while a save is in flight", async () => {
    stubApi();
    await render(true);
    const save = Promise.withResolvers<void>();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (init?.method === "PUT") await save.promise;
      return inner(input, init);
    }) as typeof fetch;
    try {
      const fields = () =>
        container.querySelector<HTMLFieldSetElement>(".formBuilderFields");
      expect(fields()?.disabled).toBe(false);
      const publish = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent === "Publish");
      await act(async () => publish?.click());
      // The saved template replaces this one when it lands; no edits meanwhile.
      expect(fields()?.disabled).toBe(true);
      // Reorder handles sit outside what a fieldset disables.
      const before = prompts();
      await press(
        questions()[0]?.querySelector(".formDragHandle"),
        "ArrowDown",
      );
      for (const [index, row] of questions().entries()) {
        row.getBoundingClientRect = () =>
          ({ height: 100, top: index * 100 }) as DOMRect;
      }
      const first = questions()[0]?.querySelector(".formDragHandle");
      await pointer(first, "pointerdown", 50);
      await pointer(first, "pointermove", 260);
      await pointer(first, "pointerup", 260);
      expect(prompts()).toEqual(before);
      await act(async () => save.resolve());
      await settle(30);
      expect(fields()?.disabled).toBe(false);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it("shows other members the status without publication controls", async () => {
    stubApi();
    await render();
    const header = container.querySelector(".formVersionControls");
    expect(header?.textContent).toContain("Draft");
    expect(
      [...container.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).not.toContain("Publish");
  });
});

describe("reordering the form template", () => {
  it("moves a question from its number's menu and saves the new order", async () => {
    const saves = stubApi();
    await render();
    const number = sections()[0]?.querySelector<HTMLButtonElement>(
      'button[aria-label="Question 1 order"]',
    );
    await act(async () => number?.click());
    expect(menuItem("Move up")?.disabled).toBe(true);
    expect(menuItem("Move down")?.disabled).toBe(false);

    await act(async () => menuItem("Move down")?.click());
    await settle(30);
    expect(prompts()).toEqual(["Second", "First", "Third"]);
    expect(document.activeElement?.getAttribute("data-reorder-focus")).toBe(
      "number-q1",
    );
    expect(document.activeElement?.textContent).toBe("2");

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save as version 2"),
    );
    await act(async () => save?.click());
    await settle(30);
    expect(
      saves[0]?.definition.sections[0]?.items.map(({ prompt }) => prompt),
    ).toEqual(["Second", "First", "Third"]);
  });

  it("moves a section with its number's menu and with the arrow keys on its handle", async () => {
    stubApi();
    await render();
    const storage = sections()[1];
    await act(async () =>
      storage
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Section 2 order"]',
        )
        ?.click(),
    );
    expect(menuItem("Move down")?.disabled).toBe(true);
    await act(async () => menuItem("Move up")?.click());
    await settle(30);
    expect(sectionTitles()).toEqual(["Storage", "Kitchen"]);

    const kitchenHandle = sections()[1]?.querySelector<HTMLElement>(
      ".formSectionHeader .formDragHandle",
    );
    await press(kitchenHandle, "ArrowUp");
    expect(sectionTitles()).toEqual(["Kitchen", "Storage"]);
    expect(document.activeElement?.getAttribute("data-reorder-focus")).toBe(
      "handle-s1",
    );
    await press(document.activeElement, "ArrowUp");
    expect(sectionTitles()).toEqual(["Kitchen", "Storage"]);
  });

  it("drags a question by its handle, showing where it will land", async () => {
    stubApi();
    await render();
    for (const [index, row] of questions().entries()) {
      row.getBoundingClientRect = () =>
        ({ height: 100, top: index * 100 }) as DOMRect;
    }
    const handle = questions()[0]?.querySelector(".formDragHandle");
    await pointer(handle, "pointerdown", 50);
    await pointer(handle, "pointermove", 260);

    const [first, , third] = questions();
    expect(first?.className).toContain("formDragging");
    expect(first?.style.transform).toBe("translateY(210px)");
    expect(third?.className).toContain("formDropAfter");

    await pointer(handle, "pointerup", 260);
    await settle(30);
    expect(prompts()).toEqual(["Second", "Third", "First"]);
    expect(container.querySelector(".formDragging")).toBeNull();
    expect(prompts(1)).toEqual(["Other"]);
  });

  it("lets only the pointer that started a drag move or drop it", async () => {
    stubApi();
    await render();
    for (const [index, row] of questions().entries()) {
      row.getBoundingClientRect = () =>
        ({ height: 100, top: index * 100 }) as DOMRect;
    }
    const firstHandle = questions()[0]?.querySelector(".formDragHandle");
    const thirdHandle = questions()[2]?.querySelector(".formDragHandle");
    await pointer(firstHandle, "pointerdown", 50, 1);

    // A second finger on another handle neither starts its own drag nor
    // moves, drops, or cancels the first one.
    await pointer(thirdHandle, "pointerdown", 250, 2);
    await pointer(thirdHandle, "pointermove", 10, 2);
    await pointer(thirdHandle, "pointerup", 10, 2);
    await pointer(thirdHandle, "pointercancel", 10, 2);
    expect(questions()[0]?.className).toContain("formDragging");
    expect(questions()[2]?.className).not.toContain("formDragging");
    expect(prompts()).toEqual(["First", "Second", "Third"]);

    await pointer(firstHandle, "pointermove", 160, 1);
    await pointer(firstHandle, "pointerup", 160, 1);
    await settle(30);
    expect(prompts()).toEqual(["Second", "First", "Third"]);
    expect(container.querySelector(".formDragging")).toBeNull();
  });

  it("follows a scroll during a drag and drops where the pointer lets go", async () => {
    stubApi();
    await render();
    let scrolled = 0;
    const savedScrollY = Object.getOwnPropertyDescriptor(dom, "scrollY");
    Object.defineProperty(dom, "scrollY", {
      configurable: true,
      get: () => scrolled,
    });
    try {
      for (const [index, row] of questions().entries()) {
        row.getBoundingClientRect = () =>
          ({ height: 100, top: index * 100 - scrolled }) as DOMRect;
      }
      const handle = questions()[0]?.querySelector(".formDragHandle");
      await pointer(handle, "pointerdown", 50);
      await pointer(handle, "pointermove", 120);
      expect(container.querySelector(".formDropAfter")).toBeNull();

      // A wheel scroll moves the rows under the still pointer.
      scrolled = 200;
      await act(async () => {
        dom.dispatchEvent(new dom.Event("scroll") as never);
      });
      expect(questions()[2]?.className).toContain("formDropAfter");

      // Scrolled back with no event: letting go settles where the pointer
      // really is, not on the stale target.
      scrolled = 0;
      await pointer(handle, "pointerup", 120);
      await settle(30);
      expect(prompts()).toEqual(["First", "Second", "Third"]);
    } finally {
      if (savedScrollY) Object.defineProperty(dom, "scrollY", savedScrollY);
      else Reflect.deleteProperty(dom, "scrollY");
    }
  });

  it("ignores the arrow keys mid-drag, and cancels on Escape", async () => {
    stubApi();
    await render();
    for (const [index, row] of questions().entries()) {
      row.getBoundingClientRect = () =>
        ({ height: 100, top: index * 100 }) as DOMRect;
    }
    const third = questions()[2]?.querySelector(".formDragHandle");
    await pointer(third, "pointerdown", 250);
    await press(third, "ArrowUp");
    expect(prompts()).toEqual(["First", "Second", "Third"]);
    expect(questions()[2]?.className).toContain("formDragging");
    await pointer(third, "pointerup", 250);
    await settle(30);
    expect(prompts()).toEqual(["First", "Second", "Third"]);

    const first = questions()[0]?.querySelector(".formDragHandle");
    await pointer(first, "pointerdown", 50);
    await pointer(first, "pointermove", 260);
    expect(questions()[2]?.className).toContain("formDropAfter");
    await press(first, "Escape");
    expect(container.querySelector(".formDragging")).toBeNull();
    await pointer(first, "pointerup", 260);
    await settle(30);
    expect(prompts()).toEqual(["First", "Second", "Third"]);

    // Once nothing is being dragged, the arrow keys move entries again.
    await press(questions()[0]?.querySelector(".formDragHandle"), "ArrowDown");
    expect(prompts()).toEqual(["Second", "First", "Third"]);
  });

  it("ends a drag when another action reorders the list", async () => {
    stubApi();
    await render();
    for (const [index, row] of questions().entries()) {
      row.getBoundingClientRect = () =>
        ({ height: 100, top: index * 100 }) as DOMRect;
    }
    const third = questions()[2]?.querySelector(".formDragHandle");
    await pointer(third, "pointerdown", 250);
    await pointer(third, "pointermove", 120);
    expect(questions()[1]?.className).toContain("formDropBefore");

    // Another finger moves the first question down mid-drag.
    await act(async () =>
      sections()[0]
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Question 1 order"]',
        )
        ?.click(),
    );
    await act(async () => menuItem("Move down")?.click());
    await settle(30);
    expect(prompts()).toEqual(["Second", "First", "Third"]);
    expect(container.querySelector(".formDragging")).toBeNull();

    // The stale drag does not drop the third question into the new order.
    await pointer(third, "pointerup", 120);
    await settle(30);
    expect(prompts()).toEqual(["Second", "First", "Third"]);
  });

  it("keeps scrolling at the edge while the pointer holds still", async () => {
    stubApi();
    await render();
    let scrolled = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const replaced = {
      cancelAnimationFrame: (id: number) => frames.delete(id),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      },
    };
    const saved = new Map(
      Object.keys(replaced).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    const savedScroll = ["scrollBy", "scrollY"].map(
      (key) => [key, Object.getOwnPropertyDescriptor(dom, key)] as const,
    );
    // The page can scroll 300px when the drag begins, and no further.
    const page = dom.document.documentElement;
    Object.defineProperty(page, "scrollHeight", {
      configurable: true,
      get: () => dom.innerHeight + 300,
    });
    for (const [key, value] of Object.entries(replaced)) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    Object.defineProperty(dom, "scrollBy", {
      configurable: true,
      value: (_x: number, y: number) => {
        scrolled += y;
      },
    });
    Object.defineProperty(dom, "scrollY", {
      configurable: true,
      get: () => scrolled,
    });
    /** Runs `count` animation frames, as the browser would while still. */
    const runFrames = async (count: number) => {
      for (let frame = 0; frame < count; frame += 1) {
        const pending = [...frames.values()];
        frames.clear();
        await act(async () => {
          for (const callback of pending) callback(0);
        });
      }
    };
    try {
      // Tall questions, so reaching the next one needs the page to scroll.
      for (const [index, row] of questions().entries()) {
        row.getBoundingClientRect = () =>
          ({ height: 600, top: index * 600 - scrolled }) as DOMRect;
      }
      const edge = dom.innerHeight - 10;
      const handle = questions()[0]?.querySelector(".formDragHandle");
      await pointer(handle, "pointerdown", 50);
      await pointer(handle, "pointermove", edge);
      expect(questions()[1]?.className).not.toContain("formDropAfter");

      await runFrames(12);
      expect(scrolled).toBe(12 * 16);
      expect(questions()[1]?.className).toContain("formDropAfter");

      // It stops at the end of the page as it was, however long it waits.
      await runFrames(30);
      expect(scrolled).toBe(300);

      // Dropping stops the scrolling; the next frames only restore focus.
      await pointer(handle, "pointerup", edge);
      await runFrames(3);
      expect(scrolled).toBe(300);
      expect(prompts()).toEqual(["Second", "First", "Third"]);
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      for (const [key, descriptor] of savedScroll) {
        if (descriptor) Object.defineProperty(dom, key, descriptor);
        else Reflect.deleteProperty(dom, key);
      }
      Reflect.deleteProperty(page, "scrollHeight");
    }
  });
});

describe("the template's projects", () => {
  it("turns the template on or off for each project from the template's page", async () => {
    stubApi();
    await render();
    const toggle = (name: string) =>
      container.querySelector<HTMLInputElement>(
        `input[aria-label="Use Opening checklist in ${name}"]`,
      );
    expect(container.textContent).toContain("On for 1 project");
    expect(toggle("Clinic")?.checked).toBe(true);
    expect(toggle("Annex")?.checked).toBe(false);
    await act(async () => {
      toggle("Annex")?.click();
    });
    await settle(30);
    await act(async () => {
      toggle("Clinic")?.click();
    });
    await settle(30);
    expect(projectWrites).toEqual([
      "PUT /api/projects/annex/templates/t1",
      "DELETE /api/projects/clinic/templates/t1",
    ]);
    expect(toggle("Annex")?.checked).toBe(true);
    expect(toggle("Clinic")?.checked).toBe(false);
  });

  it("offers the projects once the draft is published", async () => {
    stubApi(false);
    await render(true);
    expect(container.textContent).toContain(
      "Publish this template to turn it on for projects.",
    );
    const publish = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Publish");
    await act(async () => publish?.click());
    await settle(30);
    expect(container.textContent).not.toContain(
      "Publish this template to turn it on for projects.",
    );
    await act(async () => {
      container
        .querySelector<HTMLInputElement>(
          'input[aria-label="Use Opening checklist in Annex"]',
        )
        ?.click();
    });
    await settle(30);
    expect(projectWrites).toEqual(["PUT /api/projects/annex/templates/t1"]);
  });

  it("opens on the Projects tab from Assign projects, then leaves the address", async () => {
    stubApi();
    window.history.replaceState(null, "", "/forms/templates/t1?tab=projects");
    await render();
    const selected = container.querySelector(
      '[role="tab"][aria-selected="true"]',
    );
    expect(selected?.textContent).toBe("Projects");
    expect(window.location.pathname + window.location.search).toBe(
      "/forms/templates/t1",
    );
  });
});
