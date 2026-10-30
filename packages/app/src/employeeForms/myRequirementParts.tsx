import { Button, type IconName } from "@balebase/ui/react";
import type {
  EmployeeRequirement,
  EmployeeRequirementKind,
} from "@balebase/validators/employeeForms";
import { type ReactNode, useCallback, useRef } from "react";
import { AppButtonLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { useAction } from "../shared/useAction";
import { useLoad } from "../shared/useLoad";
import { myDocumentsPath } from "../workspace/workspacePaths";
import {
  downloadEmployeeForm,
  downloadScreeningConsent,
} from "./employeeFormDownloads";
import { screeningProgress } from "./ScreeningRequest";

export type MyRequirementAction = (
  work: () => Promise<unknown>,
  success: string,
) => Promise<void>;

export const requirementKinds: Record<
  EmployeeRequirementKind,
  { icon: IconName; label: string }
> = {
  background_check: { icon: "security", label: "Background check" },
  credit_check: { icon: "finance", label: "Credit check" },
  form: { icon: "document", label: "Form" },
};

/**
 * The signed-in person's own requests, as they see them, and an action that
 * reloads them afterwards.
 */
export function useOwnRequirements() {
  const loaded = useLoad(
    useCallback(
      async () => (await api.employeeForms.list({ own: true })).requirements,
      [],
    ),
    "Could not load your documents.",
  );
  const change = useAction("Could not update your documents.");
  const action: MyRequirementAction = async (work, success) => {
    // Reload either way so a refused change shows what is stored, and stay
    // busy until it has, so no action runs against stale requirements.
    await change.run(async () => {
      try {
        return await work();
      } finally {
        await loaded.reload();
      }
    }, success);
  };
  return {
    action,
    busy: change.busy,
    error: change.error ?? loaded.error,
    loading: loaded.loading,
    notice: change.notice,
    reload: loaded.reload,
    requirements: loaded.data,
  };
}

/** One line on what happens next, when the badge alone doesn't say. */
export function requirementHint(
  requirement: EmployeeRequirement,
  organizationName: string,
) {
  if (requirement.checkrReportStatus && !requirement.canSubmitCheckr) {
    return screeningProgress(requirement, organizationName);
  }
  if (requirement.status === "complete") return undefined;
  if (requirement.kind === "form") {
    return requirement.status === "pending"
      ? "Upload a PDF, JPEG, or PNG."
      : `${organizationName} is reviewing ${requirement.documentFilename ?? "your file"}.`;
  }
  if (requirement.kind === "credit_check") {
    return `${organizationName} runs this check and contacts you if it needs anything.`;
  }
  if (requirement.canSubmitCheckr) {
    const location = [
      requirement.checkrWorkLocation?.city,
      requirement.checkrWorkLocation?.state,
    ]
      .filter(Boolean)
      .join(", ");
    return `Read the disclosures, enter your details, and sign. Balebase sends them to Checkr for work in ${location}.`;
  }
  return screeningProgress(requirement, organizationName);
}

/** The person's own controls for one request: start, upload, download. */
export function MyRequirementActions({
  action,
  busy,
  onNavigate,
  requirement,
}: {
  action: MyRequirementAction;
  busy: boolean;
  onNavigate: (pathname: string) => void;
  requirement: EmployeeRequirement;
}) {
  const controls: ReactNode[] = [];
  if (requirement.canSubmitCheckr || requirement.checkrReportStatus) {
    const path = myDocumentsPath(requirement.id);
    controls.push(
      <AppButtonLink
        href={path}
        key="screening"
        onNavigate={onNavigate}
        size="sm"
        variant="primary"
      >
        {!requirement.canSubmitCheckr
          ? "View screening status"
          : requirement.checkrSubmitting
            ? "Finish background check"
            : "Start background check"}
      </AppButtonLink>,
    );
  }
  if (requirement.kind === "form" && requirement.status !== "complete") {
    controls.push(
      <UploadButton
        busy={busy}
        key="upload"
        label={requirement.hasDocument ? "Replace file" : "Upload file"}
        onFile={(file) =>
          action(
            () => api.employeeForms.upload(requirement.id, file),
            `${requirement.title} sent.`,
          )
        }
        primary={requirement.status === "pending"}
      />,
    );
  }
  if (requirement.hasDocument) {
    controls.push(
      <Button
        disabled={busy}
        icon="download"
        key="document"
        onClick={() =>
          void action(
            () =>
              downloadEmployeeForm(
                requirement.id,
                requirement.documentFilename ?? "form",
              ),
            "Download started.",
          )
        }
        size="sm"
        variant="ghost"
      >
        {requirement.documentFilename ?? "Your file"}
      </Button>,
    );
  }
  if (requirement.hasCheckrConsent) {
    controls.push(
      <Button
        disabled={busy}
        icon="download"
        key="consent"
        onClick={() =>
          void action(
            () => downloadScreeningConsent(requirement.id),
            "Download started.",
          )
        }
        size="sm"
        variant="ghost"
      >
        Signed authorization
      </Button>,
    );
  }
  return <>{controls}</>;
}

function UploadButton({
  busy,
  label,
  onFile,
  primary,
}: {
  busy: boolean;
  label: string;
  onFile: (file: File) => Promise<void>;
  primary: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        aria-label={label}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
          event.target.value = "";
        }}
        ref={input}
        type="file"
      />
      <Button
        disabled={busy}
        icon="upload"
        onClick={() => input.current?.click()}
        size="sm"
        variant={primary ? "primary" : "secondary"}
      >
        {label}
      </Button>
    </>
  );
}
