import { DialogHost } from "@balebase/ui/react";
import type { AuditTemplate } from "@balebase/validators/audits";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OfflineWorkspacePage } from "../src/offline/OfflineWorkspacePage";
import {
  activateOfflineWorkspace,
  activeOfflineKey,
  changeOfflineWorkspace,
  lockOfflineWorkspace,
  offlineImage,
  offlineScopeKey,
  readOfflineWorkspace,
} from "../src/offline/offlineStore";
import { syncOfflineWorkspace } from "../src/offline/offlineSync";
import {
  createOfflineIssue,
  queueOfflineAudit,
  retryOfflineWork,
  saveOfflineAnswer,
  startOfflineAudit,
} from "../src/offline/offlineWork";
import { useOfflineWorkspace } from "../src/offline/useOfflineWorkspace";
import { useWorkspaceNavigation } from "../src/workspace/navigationGuard";

const user = {
  id: "user-1",
  name: "Inspector",
  email: "inspector@example.com",
};
const scope = { userId: user.id, organizationId: "org-1" };
const key = offlineScopeKey(scope);
const template: AuditTemplate = {
  id: "form",
  name: "Safety inspection",
  description: "Offline checklist",
  scope: "organization",
  status: "draft",
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

function App() {
  const offline = useOfflineWorkspace();
  const [path, setPath] = useState(location.pathname);
  const navigate = useWorkspaceNavigation(setPath);
  if (path.startsWith("/issues/")) return <p>Synced issue</p>;
  return (
    <OfflineWorkspacePage
      workspace={offline.workspace}
      online={offline.online}
      storageError={offline.error}
      onNavigate={navigate}
    />
  );
}

const testApi = {
  key,
  activeKey: activeOfflineKey,
  async seed() {
    await changeOfflineWorkspace(
      key,
      (current) =>
        current ?? {
          key,
          scope,
          user,
          organizationName: "Test team",
          templates: [template],
          members: [user],
          audits: [],
          issues: [],
          jobs: [],
        },
    );
    activateOfflineWorkspace(key);
    return startOfflineAudit(key, template);
  },
  read: () => readOfflineWorkspace(key),
  answer: (id: string, value: string) =>
    saveOfflineAnswer(key, id, "check", value),
  queue: (id: string) => queueOfflineAudit(key, id),
  issue: (auditId?: string) =>
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
      auditId ? { auditId, itemId: "check" } : undefined,
    ),
  photo: (id: string) =>
    offlineImage(key, id).then(async (blob) => ({
      type: blob.type,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    })),
  retry: () => retryOfflineWork(key),
  sync: () => syncOfflineWorkspace(key),
  lock: lockOfflineWorkspace,
  activate: () => activateOfflineWorkspace(key),
  other: () =>
    readOfflineWorkspace(offlineScopeKey({ ...scope, userId: "other" })),
  abort: () =>
    changeOfflineWorkspace(key, (workspace) => {
      if (workspace) workspace.templates = [];
      throw new Error("Simulated storage failure");
    }),
  mount: () => {
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
