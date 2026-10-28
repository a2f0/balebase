import { productName } from "@balebase/ui/brand";
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { useCallback } from "react";
import { api } from "./apiClient";
import { downloadScreeningConsent } from "./employeeFormDownloads";
import { formatDate } from "./labels";
import { localDate, personalRequirement } from "./requirementStatus";
import { ScreeningForm } from "./ScreeningForm";
import { useAction } from "./useAction";
import { useLoad } from "./useLoad";
import { handleNavigation } from "./workspacePaths";

/** An emailed screening link remains useful after the person submits. */
export function ScreeningRequest({
  back,
  onNavigate,
  organizationName,
  requirementId,
}: {
  back: string;
  onNavigate: (pathname: string) => void;
  organizationName: string;
  requirementId: string;
}) {
  const loaded = useLoad(
    useCallback(async () => {
      const { requirements } = await api.employeeForms.list({ own: true });
      const current = requirements.find(
        (item) => item.id === requirementId && item.kind === "background_check",
      );
      if (!current) throw new Error("Background check not found.");
      return current;
    }, [requirementId]),
    "Could not load your background check.",
  );
  const download = useAction("Could not download your authorization.");
  const requirement = loaded.data;
  const error = download.error ?? loaded.error;
  const busy = download.busy || loaded.loading;
  const backLink = (
    <ButtonLink
      href={back}
      onClick={(event) => handleNavigation(event, back, onNavigate)}
      size="sm"
    >
      Back to My documents
    </ButtonLink>
  );
  if (!requirement)
    return error ? (
      <Banner actions={backLink} tone="danger">
        {error}
      </Banner>
    ) : (
      <LoadingState label="Loading background check…" />
    );
  if (requirement.canSubmitCheckr)
    return (
      <ScreeningForm
        back={back}
        onNavigate={onNavigate}
        requirementId={requirementId}
      />
    );
  const { badge } = personalRequirement(requirement, localDate());
  return (
    <div className="screeningForm">
      <Card
        title={requirement.title}
        actions={
          <>
            <Button disabled={busy} onClick={() => void loaded.reload()}>
              Refresh status
            </Button>
            {requirement.hasCheckrConsent && (
              <Button
                disabled={busy}
                onClick={() =>
                  void download.run(() =>
                    downloadScreeningConsent(requirementId),
                  )
                }
                variant="ghost"
              >
                Download your signed authorization
              </Button>
            )}
            {backLink}
          </>
        }
      >
        {error && <Toast tone="danger">{error}</Toast>}
        <Badge tone={badge.tone}>
          {requirement.checkrReportStatus === "complete"
            ? "Report ready"
            : badge.label}
        </Badge>
        <p>{screeningProgress(requirement, organizationName)}</p>
        {requirement.completedAt && (
          <p className="muted">
            Completed {formatDate(requirement.completedAt)}.
          </p>
        )}
        {requirement.checkrReportStatus && (
          <p>
            Checkr provides the background screening. Use the links in Checkr’s
            emails to view your report, provide requested information, or ask
            about corrections and disputes.
          </p>
        )}
        <p className="muted">
          {productName} shows the latest status received from Checkr.
        </p>
      </Card>
    </div>
  );
}

export function screeningProgress(
  requirement: EmployeeRequirement,
  organizationName: string,
) {
  const status = requirement.checkrReportStatus;
  if (status === "complete")
    return `${organizationName} reviews your report and contacts you about next steps. A completed report is not a hiring decision.`;
  if (requirement.status === "complete")
    return `${organizationName} marked this check complete.`;
  if (status === "suspended")
    return "Your report is on hold. Check your email for a request from Checkr for additional information.";
  if (status === "dispute")
    return "Checkr is reviewing a dispute about your report. Checkr will contact you about the outcome.";
  if (status === "canceled" || status === "partially_canceled")
    return `This report ${status === "partially_canceled" ? "was partly canceled" : "was canceled"}. Contact ${organizationName} about next steps.`;
  if (status)
    return "Checkr is preparing your report and contacts you if it needs anything. You can return here to check its status.";
  return `${organizationName} sends you this check when it’s ready.`;
}
