import { answerBase, offlineAnswers } from "@balebase/client-sdk";
import { OfflineStore } from "@balebase/client-sdk/testing";
import { DialogHost } from "@balebase/ui/react";
import type { FormTemplate } from "@balebase/validators/forms";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { balebase } from "../src/balebase";
import { DeviceContext } from "../src/offline/offlineContext";
import { useOfflineWorkspace } from "../src/offline/useOfflineWorkspace";
import { DeviceProjects } from "../src/projects/DeviceProjects";
import { apiUrl } from "../src/shared/config";
import { useWorkspaceNavigation } from "../src/workspace/navigationGuard";

const user = {
  id: "user-1",
  name: "Inspector",
  email: "inspector@example.com",
};
const scope = { userId: user.id, organizationId: "org-1" };
const key = balebase().offline.scopeKey(scope);
// Seeds the device directly, sharing the SDK's storage and subscribers.
const store = new OfflineStore(apiUrl);
// `seed` writes through this store and everything else reads through the
// SDK, so both must key the same workspace; otherwise the seeded workspace
// is one nothing reads, and no test would say why.
if (store.scopeKey(scope) !== key)
  throw new Error(
    "The offline fixture's store keys workspaces differently from the SDK.",
  );
const project = {
  id: "project-1",
  name: "Site",
  description: "",
  templateIds: ["template"],
};
const template: FormTemplate = {
  id: "template",
  name: "Safety inspection",
  description: "Offline checklist",
  scope: "organization",
  status: "published",
  version: 1,
  currentVersion: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  savedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  savedBy: user,
  definition: {
    version: 1,
    sections: [
      {
        id: "section",
        title: "Building",
        items: [
          {
            id: "check",
            prompt: "Safe?",
            required: true,
            responseType: "check",
          },
        ],
      },
    ],
  },
};

/** The device's projects, as the App shows them, without the rest of the App. */
function App() {
  const device = useOfflineWorkspace();
  const [path, setPath] = useState(location.pathname);
  const navigate = useWorkspaceNavigation(setPath);
  if (path.startsWith("/issues/")) return <p>Synced issue</p>;
  if (path.startsWith("/forms/runs/")) return <p>Synced form</p>;
  return (
    <DeviceContext.Provider value={device}>
      <DeviceProjects onNavigate={navigate} pathname={path} />
    </DeviceContext.Provider>
  );
}

const testApi = {
  key,
  activeKey: () => balebase().offline.activeKey(),
  /** The device path of a form this fixture started. */
  formPath: (formId: string) =>
    `/projects/${project.id}/forms/${encodeURIComponent(formId)}`,
  /** Stores a synced project and its template, then starts a form from it. */
  async seed() {
    await store.change(
      key,
      (current) =>
        current ?? {
          ...store.emptyWorkspace({
            scope,
            user,
            organizationName: "Test team",
          }),
          projects: [project],
          templates: [template],
          members: [user],
        },
    );
    balebase().offline.activate(key);
    return balebase().offline.startForm(key, template, project.id);
  },
  read: () => balebase().offline.read(key),
  /** Answers the only item over the answer the form shows now. */
  answer: async (id: string, value: string) => {
    const form = (await balebase().offline.read(key))?.forms.find(
      (entry) => entry.id === id,
    );
    return balebase().offline.saveAnswer(key, id, "check", {
      at: new Date().toISOString(),
      base: form ? answerBase(form, "check") : null,
      value,
    });
  },
  /** The answers a form shows. */
  answers: async (id: string) => {
    const form = (await balebase().offline.read(key))?.forms.find(
      (entry) => entry.id === id,
    );
    return form && offlineAnswers(form);
  },
  progress: (id: string) => balebase().offline.saveProgress(key, id),
  complete: (id: string) => balebase().offline.completeForm(key, id),
  /** Raises an issue, with one photo, on the form's only item. */
  issue: (formId: string) =>
    balebase().offline.createIssue(
      key,
      {
        title: "Broken rail",
        description: "Staircase",
        priority: "high",
        assignedTo: null,
      },
      [
        new File([new Uint8Array([1, 2, 3, 4])], "rail.png", {
          type: "image/png",
        }),
      ],
      { formId, itemId: "check" },
    ),
  photo: (id: string) =>
    balebase()
      .offline.image(key, id)
      .then(async (blob) => ({
        type: blob.type,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      })),
  retry: () => balebase().offline.retry(key),
  sync: () => balebase().offline.sync(key),
  /** Reads the server's copy of each shared form, as a project sync does. */
  pull: () =>
    balebase().offline.pullForms(
      { scope, user, organizationName: "Test team" },
      balebase().offline.accessEpoch(),
    ),
  lock: () => balebase().offline.lock(),
  activate: () => balebase().offline.activate(key),
  other: () =>
    balebase().offline.read(
      balebase().offline.scopeKey({ ...scope, userId: "other" }),
    ),
  abort: () =>
    store.change(key, (workspace) => {
      if (workspace) workspace.templates = [];
      throw new Error("Simulated storage failure");
    }),
  /** Renders the device's projects at `path` (the seeded project by default). */
  mount: (path = `/projects/${project.id}`) => {
    history.replaceState(null, "", path);
    const root = document.getElementById("root");
    if (root)
      createRoot(root).render(
        <>
          <App />
          <DialogHost />
        </>,
      );
  },
};
declare global {
  interface Window {
    offlineTest: typeof testApi;
  }
}
window.offlineTest = testApi;
