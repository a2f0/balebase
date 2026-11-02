import { expect, it } from "bun:test";
import { act } from "react";
import { installDom } from "../testing/dom";
import { Library } from "./Library";

const {
  mount,
  respond,
  window: dom,
} = installDom({ url: "http://localhost:5173/" });

const user = { email: "sam@example.com", emailVerified: true, name: "Sam" };

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

it("links each file to its history", async () => {
  respond(async (url) =>
    Response.json(
      url.pathname === "/api/objects"
        ? {
            objects: [
              {
                contentType: "application/pdf",
                createdAt: "2026-10-01T09:00:00.000Z",
                filename: "lease.pdf",
                folderId: null,
                id: "file/1",
                objectKey: "key",
                size: 10,
              },
            ],
          }
        : { folders: [] },
    ),
  );
  const navigations: string[] = [];
  const { container } = await mount(
    <Library
      onNavigate={(pathname) => navigations.push(pathname)}
      onResendVerification={async () => undefined}
      pathname="/"
      user={user}
    />,
  );
  await settle();
  const link = container.querySelector<HTMLAnchorElement>(
    '[aria-label="History of lease.pdf"]',
  );
  expect(link?.getAttribute("href")).toBe("/library/files/file%2F1");
  await act(async () => link?.click());
  expect(navigations).toEqual(["/library/files/file%2F1"]);
});

it("reads a file's history, even once the file is gone", async () => {
  const requests: string[] = [];
  respond(async (url) => {
    requests.push(url.pathname);
    return Response.json({
      events: [
        {
          action: "library.file_deleted",
          actor: {
            apiKey: null,
            email: "sam@example.com",
            id: "u1",
            name: "Sam",
          },
          details: { filename: "lease.pdf", folderId: null },
          historical: false,
          id: 3,
          occurredAt: "2026-10-02T09:00:00.000Z",
          root: { id: "file/1", label: "lease.pdf", type: "library_file" },
          subject: { id: "file/1", type: "library_file" },
        },
      ],
      nextCursor: null,
    });
  });
  const { container } = await mount(
    <Library
      onNavigate={() => undefined}
      onResendVerification={async () => undefined}
      pathname="/library/files/file%2F1"
      user={user}
    />,
  );
  await settle();
  expect(requests).toEqual(["/api/objects/file%2F1/activity"]);
  expect(container.querySelector("h1")?.textContent).toBe("File history");
  expect(container.textContent).toContain("Sam deleted a file");
});

it("puts a folder's files, emails, and activity on separate tabs", async () => {
  const folder = {
    createdAt: "2026-10-01T09:00:00.000Z",
    emailCount: 0,
    fileCount: 0,
    id: "folder-1",
    name: "Leases",
  };
  respond(async (url) => {
    if (url.pathname.endsWith("/activity"))
      return Response.json({ events: [], nextCursor: null });
    if (url.pathname === "/api/library/folders/folder-1")
      return Response.json({ emails: [], folder });
    if (url.pathname === "/api/library/folders")
      return Response.json({ folders: [folder] });
    return Response.json({ objects: [] });
  });
  const { container } = await mount(
    <Library
      onNavigate={() => undefined}
      onResendVerification={async () => undefined}
      pathname="/library/folder-1"
      user={user}
    />,
  );
  await settle();
  const tabs = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Folder sections"] [role="tab"]',
    ),
  ];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "Files",
    "Emails",
    "Activity",
  ]);
  const visible = () =>
    [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.getAttribute("aria-labelledby") ?? undefined);
  expect(visible()).toEqual([tabs[0]?.id]);
  expect(container.textContent).toContain("This folder is empty");

  await act(async () => tabs[2]?.click());
  expect(visible()).toEqual([tabs[2]?.id]);
  await act(async () => {
    tabs[2]?.dispatchEvent(
      new dom.KeyboardEvent("keydown", {
        bubbles: true,
        key: "ArrowLeft",
      }) as never,
    );
  });
  expect(visible()).toEqual([tabs[1]?.id]);
  expect(document.activeElement).toBe(tabs[1] ?? null);
});
