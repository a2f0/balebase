import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadingState,
  Toast,
} from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import { AppButtonLink, AppLink } from "../shared/AppLink";
import { formatCalendarDate, formatDate } from "../shared/labels";
import {
  myDocumentsPath,
  organizationPeoplePath,
} from "../workspace/workspacePaths";
import {
  CheckrResult,
  RequirementActions,
  useManagedRequirements,
} from "./EmployeeForms";
import { requirementKinds } from "./myRequirementParts";
import { managerNextStep, requirementBadge } from "./requirementStatus";

/**
 * A manager's page for one requested form or check: who it's for, where it
 * stands, what happens next, and every control the People list offers.
 */
export function OrganizationRequirementPage({
  canManage,
  onNavigate,
  requirementId,
}: {
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  if (!canManage) {
    return (
      <EmptyState
        actions={
          <AppButtonLink href={myDocumentsPath()} onNavigate={onNavigate}>
            Open My documents
          </AppButtonLink>
        }
        icon="lock"
        title="Only organization managers can open requests here."
      >
        Your own forms and checks are in My documents.
      </EmptyState>
    );
  }
  return (
    <ManagedRequirement onNavigate={onNavigate} requirementId={requirementId} />
  );
}

function ManagedRequirement({
  onNavigate,
  requirementId,
}: {
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const { action, busy, error, loading, notice, reload, requirements } =
    useManagedRequirements();
  const requirement = requirements?.find(({ id }) => id === requirementId);
  const back = (
    <BackLink memberId={requirement?.memberId} onNavigate={onNavigate} />
  );
  if (!requirements) {
    return (
      <>
        {back}
        {loading ? (
          <LoadingState label="Loading request…" />
        ) : (
          <Banner
            actions={
              <Button onClick={() => void reload()} size="sm">
                Try again
              </Button>
            }
            tone="danger"
          >
            {error ?? "Could not load requirements."}
          </Banner>
        )}
      </>
    );
  }
  if (!requirement) {
    return (
      <>
        {back}
        {notice && <Toast tone="success">{notice}</Toast>}
        <EmptyState icon="document" title="This request isn’t here">
          It may have been removed.
        </EmptyState>
      </>
    );
  }
  const badge = requirementBadge(requirement);
  return (
    <>
      {back}
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      <Card
        actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
        description={requirementKinds[requirement.kind].label}
        title={requirement.title}
      >
        <RequirementFacts onNavigate={onNavigate} requirement={requirement} />
        {requirement.checkrResult && (
          <CheckrResult
            completedAt={requirement.completedAt}
            result={requirement.checkrResult}
          />
        )}
      </Card>
      <Card title="Next step">
        <p>{managerNextStep(requirement)}</p>
        <RequirementActions
          action={action}
          busy={busy}
          requirement={requirement}
        />
      </Card>
    </>
  );
}

function RequirementFacts({
  onNavigate,
  requirement,
}: {
  onNavigate: (pathname: string) => void;
  requirement: EmployeeRequirement;
}) {
  const person = requirement.targetName ?? requirement.targetEmail ?? "—";
  const location = requirement.checkrWorkLocation;
  return (
    <dl className="keyValue">
      <dt>Requested from</dt>
      <dd>
        {requirement.memberId ? (
          <AppLink
            href={organizationPeoplePath(requirement.memberId)}
            onNavigate={onNavigate}
          >
            {person}
          </AppLink>
        ) : (
          person
        )}
        {requirement.invitationId && requirement.invitationStatus === "pending"
          ? " (invited)"
          : !requirement.memberId
            ? " (no longer a member)"
            : ""}
      </dd>
      {requirement.targetName && requirement.targetEmail && (
        <>
          <dt>Email</dt>
          <dd>{requirement.targetEmail}</dd>
        </>
      )}
      <dt>Due</dt>
      <dd>{formatCalendarDate(requirement.dueDate)}</dd>
      {requirement.completedAt && (
        <>
          <dt>Completed</dt>
          <dd>{formatDate(requirement.completedAt)}</dd>
        </>
      )}
      {requirement.kind === "background_check" && (
        <>
          <dt>Checkr</dt>
          <dd>{checkrStage(requirement)}</dd>
        </>
      )}
      {location && (
        <>
          <dt>Work location</dt>
          <dd>{[location.city, location.state].filter(Boolean).join(", ")}</dd>
        </>
      )}
      {requirement.checkrReportStatus && (
        <>
          <dt>Report status</dt>
          <dd>{requirement.checkrReportStatus.replaceAll("_", " ")}</dd>
        </>
      )}
      {requirement.documentFilename && (
        <>
          <dt>File</dt>
          <dd>{requirement.documentFilename}</dd>
        </>
      )}
      {requirement.hasCheckrConsent && (
        <>
          <dt>Authorization</dt>
          <dd>Signed</dd>
        </>
      )}
    </dl>
  );
}

function checkrStage(requirement: EmployeeRequirement) {
  if (requirement.checkrReportStatus) return "Report ordered";
  if (requirement.checkrSubmitting) return "Submitting";
  if (requirement.checkrRequested) return "Requested, waiting for details";
  if (requirement.checkrAvailable) return "Not requested";
  return "Not available; tracked by hand";
}

function BackLink({
  memberId,
  onNavigate,
}: {
  memberId: string | null | undefined;
  onNavigate: (pathname: string) => void;
}) {
  return (
    <div>
      <AppButtonLink
        href={organizationPeoplePath(memberId ?? undefined)}
        icon="arrowLeft"
        onNavigate={onNavigate}
        size="sm"
        variant="ghost"
      >
        {memberId ? "Back to member" : "All people"}
      </AppButtonLink>
    </div>
  );
}
