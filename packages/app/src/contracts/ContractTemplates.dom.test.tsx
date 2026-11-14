import { describe, expect, it } from "bun:test";
import { DialogHost } from "@balebase/ui/react";
import type { ContractTemplate } from "@balebase/validators/contractTemplates";
import { act, StrictMode, useEffect, useState } from "react";
import { installDom } from "../testing/dom";
import {
  canNavigate,
  guardWorkspaceChange,
} from "../workspace/navigationGuard";
import { ContractAuthoringEditor } from "./ContractAuthoringEditor";
import {
  EditorOverlay,
  FieldHelp,
  FieldToolbox,
  SelectedField,
  useContractFieldEditor,
} from "./ContractFieldEditor";
import { Contracts } from "./Contracts";
import { newAuthoredDraft } from "./contractAuthoringState";
import type { DraftInput } from "./contractFields";
import { templateValueKeys } from "./contractTemplateAuthoring";
import { useTemplateRequest } from "./contractTemplateState";

const {
  button,
  click,
  fill,
  mount,
  render,
  respond,
  settle,
  window: dom,
} = installDom({ url: "http://localhost:5173/contracts/templates/t1" });

function template(version = 2): ContractTemplate {
  return {
    authoring: null,
    currentStatus: "published",
    status: "published",
    createdAt: "2026-10-01T12:00:00.000Z",
    createdByName: "Owner",
    currentVersion: 2,
    definition: {
      fields: [
        {
          height: 0.05,
          label: null,
          page: 1,
          required: true,
          roleKey: "employee",
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
      ],
      message: "Please sign",
      reminderIntervalDays: 3,
      roles: [{ key: "employee", label: "Employee", routingOrder: 1 }],
      signingOrder: "parallel",
    },
    description: "Employment document",
    document: {
      filename: "agreement.pdf",
      pageCount: 2,
      sha256: "abc",
      size: 800,
    },
    id: "t1",
    name: version === 1 ? "Original agreement" : "Employment agreement",
    version,
  };
}

interface TemplatePost {
  dueDate?: string | null;
  recipients?: Array<{ email: string; name: string; roleKey: string }>;
  title?: string;
  version?: number;
  definition?: ContractTemplate["definition"];
  expectedCurrentVersion?: number;
  name?: string;
  sourceVersion?: number;
  authoring?: ContractTemplate["authoring"];
  status?: "published" | "unpublished";
  values?: Record<string, string>;
}

/** Each read of the template's history, in order. */
const activityReads: string[] = [];

function stubApi(
  options: {
    conflict?: boolean;
    createResponse?: Promise<Response>;
    uploadResponse?: Promise<Response>;
    deleteResponse?: Promise<Response>;
    detail?: ContractTemplate;
    versionResponse?: Promise<Response>;
  } = {},
) {
  const posts: Array<{ body: TemplatePost; url: string }> = [];
  const detail = (version = 2) =>
    options.detail ? { ...options.detail, version } : template(version);
  activityReads.length = 0;
  respond(async ({ href: url }, init) => {
    if (url.includes("/activity")) {
      activityReads.push(url);
      return Response.json({
        events: [
          {
            action: "contract_template.created",
            actor: {
              apiKey: null,
              email: "o@example.com",
              id: "o",
              name: "Owner",
            },
            details: { name: "Original agreement", pageCount: 2, version: 1 },
            historical: false,
            id: 1,
            occurredAt: "2026-10-01T12:00:00.000Z",
            root: {
              id: "t1",
              label: "Original agreement",
              type: "contract_template",
            },
            subject: { id: "t1", type: "contract_template" },
          },
        ],
        nextCursor: null,
      });
    }
    if (init?.method === "DELETE")
      return options.deleteResponse ?? new Response(null, { status: 204 });
    if (init?.body instanceof FormData)
      return (
        options.uploadResponse ??
        Response.json({ template: template() }, { status: 201 })
      );
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as TemplatePost;
      posts.push({ body, url });
      if (url.endsWith("/authored"))
        return Response.json(
          {
            template: {
              ...detail(1),
              authoring: body.authoring,
              definition: body.definition,
              name: body.name,
              currentVersion: 1,
              currentStatus: "draft",
              status: "draft",
            },
          },
          { status: 201 },
        );
      if (url.endsWith("/versions"))
        return options.conflict
          ? Response.json(
              {
                error:
                  "This template changed. Reload the latest version before saving your changes.",
              },
              { status: 409 },
            )
          : Response.json(
              {
                template: {
                  ...detail((body.expectedCurrentVersion ?? 2) + 1),
                  currentVersion: (body.expectedCurrentVersion ?? 2) + 1,
                  definition: body.definition,
                  name: body.name,
                  authoring: body.authoring ?? detail().authoring,
                  status: body.status ?? detail().currentStatus,
                  currentStatus: body.status ?? detail().currentStatus,
                },
              },
              { status: 201 },
            );
      return (
        options.createResponse ??
        Response.json({ contractId: "c1" }, { status: 201 })
      );
    }
    if (url.includes("/document")) return new Response(null, { status: 404 });
    if (url.endsWith("/versions"))
      return Response.json({
        versions: [2, 1].map((version) => ({
          createdAt: template().createdAt,
          createdByName: "Owner",
          name: template(version).name,
          version,
          status: detail(version).status,
        })),
      });
    if (url.endsWith("/templates"))
      return Response.json({
        templates: [
          {
            ...detail(),
            format: detail().authoring ? "markdown" : "pdf",
            updatedAt: template().createdAt,
          },
        ],
      });
    if (url.includes("version=1") && options.versionResponse)
      return options.versionResponse;
    return Response.json({
      template: detail(url.includes("version=1") ? 1 : 2),
    });
  });
  return posts;
}

async function mountContracts(
  pathname = "/contracts/templates/t1",
  onNavigate: (path: string) => void = () => {},
  canPublish = false,
) {
  const { container } = await mount(
    <>
      <Contracts
        canPublish={canPublish}
        onNavigate={onNavigate}
        pathname={pathname}
      />
      <DialogHost />
    </>,
  );
  await settle();
  return container;
}

/** Answers the open dialog with the button labelled `label`. */
async function answer(label: string) {
  await settle();
  const dialog = document.querySelector("dialog[open]");
  if (!dialog) throw new Error("No open dialog");
  await click(button(label, dialog));
}

/** Starts a guarded action, answers its dialog, and returns its result. */
async function decide<Result>(start: () => Promise<Result>, label: string) {
  let action: Promise<Result> | undefined;
  await act(async () => {
    action = start();
  });
  await answer(label);
  return action;
}
function field(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("label")].find(
    (element) =>
      element.querySelector(".fieldLabel")?.textContent?.trim() === label,
  );
  const found =
    element?.querySelector("input,select,textarea") ??
    container.querySelector(`#${element?.htmlFor}`);
  expect(found).toBeTruthy();
  return found as HTMLInputElement;
}
async function change(input: HTMLInputElement, value: string) {
  await fill(input, value);
  await settle();
}

describe("contract templates, mounted", () => {
  it("routes the templates list separately from issued contracts", async () => {
    stubApi();
    const navigations: string[] = [];
    const container = await mountContracts("/contracts/templates", (path) =>
      navigations.push(path),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Contract templates",
    );
    await click(
      container.querySelector(
        "a[href='/contracts/templates/t1']",
      ) as HTMLElement,
    );
    expect(navigations).toEqual(["/contracts/templates/t1"]);
  });

  it("saves boxes under unassigned roles and appends a version", async () => {
    const posts = stubApi();
    const container = await mountContracts();
    expect(container.querySelector("input[type=email]")).toBeNull();
    await change(field(container, "Role 1"), "Worker");
    await click(button("Full name", container));
    await click(button("Save version 3", container));
    const definition = posts[0]?.body
      .definition as ContractTemplate["definition"];
    expect(definition.roles).toEqual([
      { key: "employee", label: "Worker", routingOrder: 1 },
    ]);
    expect(
      definition.fields.map(({ type, roleKey }) => ({ roleKey, type })),
    ).toEqual([
      { roleKey: "employee", type: "signature" },
      { roleKey: "employee", type: "name" },
    ]);
    expect(posts[0]?.body.expectedCurrentVersion).toBe(2);
    expect(posts[0]?.body.sourceVersion).toBe(2);
    expect(container.querySelector(".toast")?.textContent).toContain(
      "Version 3 saved",
    );
    expect(button("Save version 4", container).disabled).toBe(true);
    // The template's history is read on opening and again after the save.
    expect(container.textContent).toContain(
      "Owner uploaded a contract template",
    );
    expect(activityReads).toEqual([
      "http://localhost:8787/api/contracts/templates/t1/activity",
      "http://localhost:8787/api/contracts/templates/t1/activity",
    ]);
  });

  it("uses a selected older version and maps its role once", async () => {
    const posts = stubApi();
    const navigations: string[] = [];
    const container = await mountContracts(undefined, (path) =>
      navigations.push(path),
    );
    await change(field(container, "Version"), "1");
    expect(container.querySelector("h1")?.textContent).toBe(
      "Original agreement",
    );
    await click(button("Use this version", container));
    await change(field(container, "Employee name"), "Sam Signer");
    await change(field(container, "Employee email"), "sam@example.com");
    await act(async () =>
      fire(
        container.querySelector("form"),
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await settle();
    expect(posts[0]?.body).toEqual({
      dueDate: null,
      recipients: [
        { email: "sam@example.com", name: "Sam Signer", roleKey: "employee" },
      ],
      title: "Original agreement",
      version: 1,
    });
    expect(navigations).toEqual(["/contracts/c1"]);
  });

  it("preserves edits after a conflict and prevents discarded navigation", async () => {
    stubApi({ conflict: true });
    const container = await mountContracts();
    await change(field(container, "Role 1"), "Worker");
    expect(await decide(canNavigate, "Keep editing")).toBe(false);
    await click(button("Use this version", container));
    expect(document.querySelector("dialog[open]")?.textContent).toContain(
      "Discard unsaved changes?",
    );
    await answer("Keep editing");
    expect(container.querySelector("input[type=email]")).toBeNull();
    await click(button("Save version 3", container));
    expect(container.textContent).toContain("This template changed");
    expect(field(container, "Role 1").value).toBe("Worker");
    expect(button("Save version 3", container).disabled).toBe(false);
  });

  it("guards account, organization, and sign-out actions before changing the session", async () => {
    stubApi();
    const container = await mountContracts();
    await change(field(container, "Role 1"), "Worker");
    const changes: string[] = [];
    const switchAccount = guardWorkspaceChange(async (id: string) => {
      changes.push(`account:${id}`);
    });
    const switchOrganization = guardWorkspaceChange(async (id: string) => {
      changes.push(`organization:${id}`);
    });
    const signOut = guardWorkspaceChange(async () => {
      changes.push("sign-out");
    });
    await decide(() => switchAccount("a2"), "Keep editing");
    await decide(() => switchOrganization("org2"), "Keep editing");
    await decide(signOut, "Keep editing");
    expect(changes).toEqual([]);
    expect(field(container, "Role 1").value).toBe("Worker");
    await decide(() => switchAccount("a2"), "Discard changes");
    await decide(() => switchOrganization("org2"), "Discard changes");
    await decide(signOut, "Discard changes");
    expect(changes).toEqual(["account:a2", "organization:org2", "sign-out"]);
  });

  it("blocks version changes while creating and ignores a response after leaving the page", async () => {
    let complete: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ createResponse: response });
    const navigations: string[] = [];
    const container = await mountContracts(undefined, (path) =>
      navigations.push(path),
    );
    await click(button("Use this version", container));
    await change(field(container, "Employee name"), "Sam Signer");
    await change(field(container, "Employee email"), "sam@example.com");
    await act(async () => {
      fire(
        container.querySelector("form"),
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(field(container, "Version").disabled).toBe(true);
    expect(button("Delete template", container).disabled).toBe(true);
    await render(
      <Contracts
        onNavigate={(path) => navigations.push(path)}
        pathname="/contracts/templates"
      />,
    );
    await act(async () => {
      complete?.(
        Response.json({ contractId: "late-contract" }, { status: 201 }),
      );
    });
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe(
      "Contract templates",
    );
    expect(navigations).toEqual([]);
  });

  it("ignores an upload completion after the templates list unmounts", async () => {
    let complete: ((response: Response) => void) | undefined;
    const uploadResponse = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ uploadResponse });
    const navigations: string[] = [];
    const container = await mountContracts("/contracts/templates", (path) =>
      navigations.push(path),
    );
    const input = container.querySelector(
      "input[type=file]",
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: { 0: new File(["PDF"], "agreement.pdf"), length: 1 },
    });
    await act(async () => {
      fire(input, new dom.Event("change", { bubbles: true }));
    });
    await render(<p>Other workspace</p>);
    await act(async () => {
      complete?.(Response.json({ template: template() }, { status: 201 }));
    });
    await settle();
    expect(navigations).toEqual([]);
    expect(container.textContent).toBe("Other workspace");
  });

  it("ignores a deletion completion after leaving the template", async () => {
    let complete: ((response: Response) => void) | undefined;
    const deleteResponse = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    stubApi({ deleteResponse });
    const navigations: string[] = [];
    const container = await mountContracts(undefined, (path) =>
      navigations.push(path),
    );
    await click(button("Delete template", container));
    await answer("Delete template");
    await render(<p>Other workspace</p>);
    await act(async () => {
      complete?.(new Response(null, { status: 204 }));
    });
    await settle();
    expect(navigations).toEqual([]);
    expect(container.textContent).toBe("Other workspace");
  });
});

function FieldHarness() {
  const [draft, setDraft] = useState<DraftInput>({
    dueDate: null,
    fields: [],
    message: "",
    recipients: [{ email: "", key: "role", name: "Employee", routingOrder: 1 }],
    reminderIntervalDays: null,
    signingOrder: "parallel",
    title: "Template",
  });
  const editor = useContractFieldEditor(draft, setDraft, 2);
  return (
    <div className="contractEditor">
      <FieldHelp />
      <FieldToolbox editor={editor} />
      <SelectedField editor={editor} />
      <EditorOverlay
        editor={editor}
        page={{ height: 792, number: 1, width: 612 }}
      />
      <output>{JSON.stringify(draft.fields)}</output>
    </div>
  );
}

it("shares keyboard placement, movement, and removal with the draft editor", async () => {
  const { container } = await mount(<FieldHarness />);
  await click(button("Initials", container));
  const placed = container.querySelector(
    "button.contractField",
  ) as HTMLButtonElement;
  expect(document.activeElement).toBe(placed);
  const before = JSON.parse(
    container.querySelector("output")?.textContent ?? "[]",
  ) as Array<{ x: number }>;
  await act(async () => {
    fire(
      placed,
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowRight",
        shiftKey: true,
      }),
    );
  });
  const after = JSON.parse(
    container.querySelector("output")?.textContent ?? "[]",
  ) as Array<{ x: number }>;
  expect(after[0]?.x).toBeCloseTo((before[0]?.x ?? 0) + 0.05);
  await act(async () => {
    fire(
      placed,
      new dom.KeyboardEvent("keydown", { bubbles: true, key: "Delete" }),
    );
  });
  expect(container.querySelector("button.contractField")).toBeNull();
  expect(container.querySelector("output")?.textContent).toBe("[]");
});

function fire(element: Element | null, event: unknown) {
  return element?.dispatchEvent(event as Event);
}

function writtenTemplate(): ContractTemplate {
  return {
    ...template(),
    authoring: {
      formatVersion: 1,
      source:
        '# Offer\n\n:value[employee.name] :value[project.title] :value[project.fee]\n\n:signature{#sign role="employee"}\n',
      values: { "project.title": "Default project" },
    },
  };
}

describe("written templates, mounted", () => {
  it("creates a draft written template from the list", async () => {
    const posts = stubApi();
    const navigations: string[] = [];
    const container = await mountContracts("/contracts/templates", (path) =>
      navigations.push(path),
    );
    await click(button("New written template", container));
    await settle();
    expect(posts[0]?.url).toEndWith("/templates/authored");
    expect(posts[0]?.body.authoring?.source).toBe(newAuthoredDraft().source);
    expect(posts[0]?.body.definition?.roles).toEqual([
      { key: "client", label: "client", routingOrder: 1 },
    ]);
    expect(navigations).toEqual(["/contracts/templates/t1"]);
  });

  it("publishes the edited Markdown and role labels as an immutable new version", async () => {
    const detail = {
      ...writtenTemplate(),
      status: "draft" as const,
      currentStatus: "draft" as const,
    };
    const posts = stubApi({ detail });
    const container = await mountContracts(undefined, undefined, true);
    expect(button("Use this version", container).disabled).toBe(true);
    await click(button("Markdown", container));
    const source = `${detail.authoring?.source}\nCurrent editor changes.\n`;
    await change(field(container, "Markdown source"), source);
    await change(field(container, "Role 1"), "Worker");
    await click(button("Publish", container));
    await settle();
    expect(posts[0]?.body).toMatchObject({
      status: "published",
      expectedCurrentVersion: 2,
      sourceVersion: 2,
      authoring: { source },
      definition: {
        fields: [],
        roles: [{ key: "employee", label: "Worker", routingOrder: 1 }],
      },
    });
    expect(button("Use this version", container).disabled).toBe(false);
    expect(button("Unpublish", container)).toBeTruthy();
    expect(container.textContent).toContain(
      "Saving creates a new published version",
    );
  });

  it("keeps member saves published without exposing publication controls", async () => {
    const posts = stubApi({ detail: writtenTemplate() });
    const container = await mountContracts();
    expect(
      [...container.querySelectorAll("button")].some((item) =>
        ["Publish", "Unpublish"].includes(item.textContent?.trim() ?? ""),
      ),
    ).toBe(false);
    await change(field(container, "Template name"), "Updated written template");
    await click(button("Save version 3", container));
    await settle();
    expect(posts[0]?.body.authoring?.source).toBe(
      writtenTemplate().authoring?.source,
    );
    expect(button("Use this version", container).disabled).toBe(false);
  });

  it("unpublishes current editor contents and blocks further creation", async () => {
    const posts = stubApi({ detail: writtenTemplate() });
    const container = await mountContracts(undefined, undefined, true);
    await change(field(container, "Template name"), "Retired agreement");
    await click(button("Unpublish", container));
    await settle();
    expect(posts[0]?.body).toMatchObject({
      status: "unpublished",
      name: "Retired agreement",
    });
    expect(button("Use this version", container).disabled).toBe(true);
    expect(button("Publish", container)).toBeTruthy();
  });

  it("requires both selected and latest versions to be published", async () => {
    for (const statuses of [
      { status: "published", currentStatus: "unpublished" },
      { status: "draft", currentStatus: "published" },
    ] as const) {
      stubApi({ detail: { ...writtenTemplate(), ...statuses } });
      const container = await mountContracts();
      expect(button("Use this version", container).disabled).toBe(true);
    }
  });

  it("maps old published versions and per-use values without changing defaults", async () => {
    const detail = writtenTemplate();
    const posts = stubApi({ detail });
    const container = await mountContracts();
    expect(templateValueKeys(detail)).toEqual(["project.title", "project.fee"]);
    await change(field(container, "Version"), "1");
    await click(button("Use this version", container));
    expect(field(container, "project.title").value).toBe("Default project");
    await change(field(container, "project.title"), "Specific project");
    await change(field(container, "project.fee"), "$100");
    await change(field(container, "Employee name"), "Sam");
    await change(field(container, "Employee email"), "sam@example.com");
    await act(async () => {
      fire(
        container.querySelector("form"),
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(posts[0]?.body).toMatchObject({
      version: 1,
      values: { "project.title": "Specific project", "project.fee": "$100" },
    });
    expect(detail.authoring?.values).toEqual({
      "project.title": "Default project",
    });
  });

  it("refreshes a conflict's expected version without discarding Markdown", async () => {
    const options = { conflict: true, detail: writtenTemplate() };
    const posts = stubApi(options);
    const container = await mountContracts();
    await click(button("Markdown", container));
    const source = `${options.detail.authoring?.source}\nKeep these local edits.\n`;
    await change(field(container, "Markdown source"), source);
    await click(button("Save version 3", container));
    await settle();
    expect(field(container, "Markdown source").value).toBe(source);
    options.conflict = false;
    options.detail = { ...options.detail, currentVersion: 4 };
    await click(
      button("Refresh latest version information, keep my edits", container),
    );
    await settle();
    expect(field(container, "Markdown source").value).toBe(source);
    await click(button("Save version 5", container));
    await settle();
    expect(posts[1]?.body).toMatchObject({
      expectedCurrentVersion: 4,
      sourceVersion: 2,
      authoring: { source },
    });
  });

  it("preserves dirty source when selecting another version fails", async () => {
    const { promise: versionResponse, resolve: finish } =
      Promise.withResolvers<Response>();
    stubApi({ detail: writtenTemplate(), versionResponse });
    const container = await mountContracts();
    await click(button("Markdown", container));
    const source = `${writtenTemplate().authoring?.source}\nUnsaved source.\n`;
    await change(field(container, "Markdown source"), source);
    await change(field(container, "Version"), "1");
    await answer("Discard changes");
    expect(field(container, "Markdown source").value).toBe(source);
    await act(async () => {
      finish(Response.json({ error: "Version unavailable" }, { status: 503 }));
    });
    await settle();
    expect(container.textContent).toContain("Version unavailable");
    expect(field(container, "Markdown source").value).toBe(source);
    expect(await decide(canNavigate, "Keep editing")).toBe(false);
  });

  it("saves unsaved written source as a template without clearing the contract guard", async () => {
    const posts = stubApi();
    const { container } = await mount(
      <>
        <ContractAuthoringEditor onChanged={() => {}} onDeleted={() => {}} />
        <DialogHost />
      </>,
    );
    await settle();
    await click(button("Markdown", container));
    const source = `${newAuthoredDraft().source}\nUnsaved contract text.\n`;
    await change(field(container, "Markdown source"), source);
    await click(button("Save as template", container));
    await settle();
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    await change(field(dialog, "Template name"), "Copied agreement");
    await click(button("Create template", dialog));
    await settle();
    expect(posts[0]?.body.authoring?.source).toBe(source);
    expect(posts[0]?.body).not.toHaveProperty("dueDate");
    expect(posts[0]?.body).not.toHaveProperty("recipients");
    expect(field(container, "Markdown source").value).toBe(source);
    expect(
      container.querySelector("a[target=_blank]")?.getAttribute("href"),
    ).toBe("/contracts/templates/t1");
    expect(await decide(canNavigate, "Keep editing")).toBe(false);
  });
});

function TemplateRequestHarness({
  run,
  finished,
}: {
  run: () => Promise<string>;
  finished: (result: string) => void;
}) {
  const request = useTemplateRequest(finished);
  const start = request.start;
  useEffect(() => {
    start(run);
  }, [run, start]);
  return <output>{request.state.status}</output>;
}

it("replayed template effects submit once and late completion cannot notify after leaving", async () => {
  let calls = 0;
  const { promise: pending, resolve: finish } = Promise.withResolvers<string>();
  const run = () => {
    calls += 1;
    return pending;
  };
  const completed: string[] = [];
  await mount(
    <StrictMode>
      <TemplateRequestHarness
        run={run}
        finished={(value) => completed.push(value)}
      />
    </StrictMode>,
  );
  await settle();
  expect(calls).toBe(1);
  await render(<p>Different page</p>);
  await act(async () => {
    finish("late result");
  });
  await settle();
  expect(completed).toEqual([]);
});
