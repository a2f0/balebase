import { DialogHost } from "@balebase/ui/react";
import type { FormTemplate } from "@balebase/validators/forms";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DeviceContext } from "../src/offline/offlineContext";
import { answerBase, offlineAnswers } from "../src/offline/offlineFormState";
import { pullOfflineForms } from "../src/offline/offlinePull";
import {
  activateOfflineWorkspace,
  activeOfflineKey,
  changeOfflineWorkspace,
  emptyOfflineWorkspace,
  lockOfflineWorkspace,
  offlineAccessEpoch,
  offlineImage,
  offlineScopeKey,
  readOfflineWorkspace,
} from "../src/offline/offlineStore";
import { syncOfflineWorkspace } from "../src/offline/offlineSync";
import {
  completeOfflineForm,
  createOfflineIssue,
  retryOfflineWork,
  saveOfflineAnswer,
  saveOfflineProgress,
  startOfflineForm,
} from "../src/offline/offlineWork";
import { useOfflineWorkspace } from "../src/offline/useOfflineWorkspace";
import { DeviceProjects } from "../src/projects/DeviceProjects";
import { useWorkspaceNavigation } from "../src/workspace/navigationGuard";

const user = {
  id: "user-1",
  name: "Inspector",
  email: "inspector@example.com",
};
const scope = { userId: user.id, organizationId: "org-1" };
const key = offlineScopeKey(scope);
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
  activeKey: activeOfflineKey,
  /** The device path of a form this fixture started. */
  formPath: (formId: string) =>
    `/projects/${project.id}/forms/${encodeURIComponent(formId)}`,
  /** Stores a synced project and its template, then starts a form from it. */
  async seed() {
    await changeOfflineWorkspace(
      key,
      (current) =>
        current ?? {
          ...emptyOfflineWorkspace({
            scope,
            user,
            organizationName: "Test team",
          }),
          projects: [project],
          templates: [template],
          members: [user],
        },
    );
    activateOfflineWorkspace(key);
    return startOfflineForm(key, template, project.id);
  },
  read: () => readOfflineWorkspace(key),
  /** Answers the only item over the answer the form shows now. */
  answer: async (id: string, value: string) => {
    const form = (await readOfflineWorkspace(key))?.forms.find(
      (entry) => entry.id === id,
    );
    return saveOfflineAnswer(key, id, "check", {
      at: new Date().toISOString(),
      base: form ? answerBase(form, "check") : null,
      value,
    });
  },
  /** The answers a form shows. */
  answers: async (id: string) => {
    const form = (await readOfflineWorkspace(key))?.forms.find(
      (entry) => entry.id === id,
    );
    return form && offlineAnswers(form);
  },
  progress: (id: string) => saveOfflineProgress(key, id),
  complete: (id: string) => completeOfflineForm(key, id),
  /** Raises an issue, with one photo, on the form's only item. */
  issue: (formId: string) =>
    createOfflineIssue(
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
    offlineImage(key, id).then(async (blob) => ({
      type: blob.type,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    })),
  retry: () => retryOfflineWork(key),
  sync: () => syncOfflineWorkspace(key),
  /** Reads the server's copy of each shared form, as a project sync does. */
  pull: () =>
    pullOfflineForms(
      { scope, user, organizationName: "Test team" },
      offlineAccessEpoch(),
    ),
  lock: lockOfflineWorkspace,
  activate: () => activateOfflineWorkspace(key),
  other: () =>
    readOfflineWorkspace(offlineScopeKey({ ...scope, userId: "other" })),
  abort: () =>
    changeOfflineWorkspace(key, (workspace) => {
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
