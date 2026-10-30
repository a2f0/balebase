import {
  Badge,
  Banner,
  Button,
  Card,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  Toast,
} from "@balebase/ui/react";
import type { EmployeeRequirement } from "@balebase/validators/employeeForms";
import type { ReactNode } from "react";
import { formatCalendarDate, formatDate } from "../shared/labels";
import {
  MyRequirementActions,
  requirementHint,
  requirementKinds,
  useOwnRequirements,
} from "./myRequirementParts";
import { localDate, personalRequirement } from "./requirementStatus";

/**
 * One request in My documents: what was asked for, where it stands, what
 * happens next, and the person's controls for it.
 */
export function MyRequirementPage({
  back,
  onNavigate,
  organizationName,
  requirementId,
}: {
  back: ReactNode;
  onNavigate: (pathname: string) => void;
  organizationName: string;
  requirementId: string;
}) {
  const { action, busy, error, loading, notice, reload, requirements } =
    useOwnRequirements();
  const requirement = requirements?.find(({ id }) => id === requirementId);
  return (
    <Page>
      <PageHeader
        back={back}
        eyebrow="My documents"
        title={requirement?.title ?? "Request"}
      />
      <PageBody>
        {!requirements ? (
          loading ? (
            <LoadingState label="Loading your request…" />
          ) : (
            <Banner
              actions={
                <Button onClick={() => void reload()} size="sm">
                  Try again
                </Button>
              }
              tone="danger"
            >
              {error ?? "Could not load your request."}
            </Banner>
          )
        ) : !requirement ? (
          <Banner tone="danger">
            This request isn’t in your documents. It may have been removed.
          </Banner>
        ) : (
          <>
            {error && <Toast tone="danger">{error}</Toast>}
            {notice && <Toast tone="success">{notice}</Toast>}
            <Card
              actions={
                <Button disabled={busy} onClick={() => void reload()}>
                  Refresh status
                </Button>
              }
              title="Details"
            >
              <dl className="keyValue">
                <dt>Type</dt>
                <dd>{requirementKinds[requirement.kind].label}</dd>
                <dt>Requested by</dt>
                <dd>{organizationName}</dd>
                <dt>Status</dt>
                <dd>
                  <StatusBadge requirement={requirement} />
                </dd>
                <dt>Due</dt>
                <dd>{formatCalendarDate(requirement.dueDate)}</dd>
                {requirement.completedAt && (
                  <>
                    <dt>Completed</dt>
                    <dd>{formatDate(requirement.completedAt)}</dd>
                  </>
                )}
                {requirement.checkrWorkLocation && (
                  <>
                    <dt>Work location</dt>
                    <dd>
                      {[
                        requirement.checkrWorkLocation.city,
                        requirement.checkrWorkLocation.state,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </dd>
                  </>
                )}
                {requirement.documentFilename && (
                  <>
                    <dt>Your file</dt>
                    <dd>{requirement.documentFilename}</dd>
                  </>
                )}
              </dl>
            </Card>
            <Card title="What happens next">
              <p>
                {requirementHint(requirement, organizationName) ??
                  "Nothing more is needed from you."}
              </p>
              <div className="myDocumentActions">
                <MyRequirementActions
                  action={action}
                  busy={busy}
                  onNavigate={onNavigate}
                  requirement={requirement}
                />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function StatusBadge({ requirement }: { requirement: EmployeeRequirement }) {
  const { badge } = personalRequirement(requirement, localDate());
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}
