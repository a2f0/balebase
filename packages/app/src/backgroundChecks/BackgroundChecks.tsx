import { productName } from "@balebase/ui/brand";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  LoadingState,
  Page,
  PageBody,
  PageHeader,
  PageSection,
  Select,
  Toast,
} from "@balebase/ui/react";
import {
  type EmployeeRequirement,
  isBackgroundCheck,
} from "@balebase/validators/employeeForms";
import { useCallback, useEffect, useRef, useState } from "react";
import { useManagedRequirements } from "../employeeForms/EmployeeForms";
import { RequirementSections } from "../employeeForms/OrganizationRequirementPage";
import { requirementBadge } from "../employeeForms/requirementStatus";
import { usePaidFeaturesEnabled } from "../organizations/PaidFeatures";
import { AppButtonLink } from "../shared/AppLink";
import { api } from "../shared/apiClient";
import { ListRow } from "../shared/ListRow";
import { countLabel, formatCalendarDate } from "../shared/labels";
import { useLoad } from "../shared/useLoad";
import {
  backgroundCheckIdForPath,
  backgroundCheckPath,
} from "../workspace/workspacePaths";

const title = "Background check";

/**
 * The organization's Checkr background checks, for members of a group with
 * Background checks access: request one of a member or invitee, follow where
 * each stands, and open one to request it from Checkr or read its result.
 */
export function BackgroundChecks({
  canManage = false,
  onNavigate,
  pathname,
}: {
  /** Owners and admins can open the People pages a check names. */
  canManage?: boolean;
  onNavigate: (pathname: string) => void;
  pathname: string;
}) {
  const requirementId = backgroundCheckIdForPath(pathname);
  // Keyed so each page starts from its own state and ignores the other's
  // responses after navigation.
  return requirementId ? (
    <BackgroundCheckPage
      canManage={canManage}
      key={requirementId}
      onNavigate={onNavigate}
      requirementId={requirementId}
    />
  ) : (
    <BackgroundCheckList onNavigate={onNavigate} />
  );
}

function BackgroundCheckList({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  const { action, busy, error, loading, notice, reload, requirements } =
    useManagedRequirements();
  const [requesting, setRequesting] = useState(false);
  // Tags each request, so one that answers after the form closed or the page
  // went away opens nothing.
  const requestTag = useRef(0);
  useEffect(
    () => () => {
      requestTag.current += 1;
    },
    [],
  );
  const checks = requirements?.filter(({ kind }) => isBackgroundCheck(kind));
  return (
    <Page>
      <PageHeader
        actions={
          !requesting && (
            <Button
              icon="add"
              onClick={() => setRequesting(true)}
              variant="primary"
            >
              Request a check
            </Button>
          )
        }
        description="Checkr background checks requested of members and invitees: who each is for, where it stands, and its result."
        eyebrow="Records"
        title="Background checks"
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {requesting && (
          <BackgroundCheckRequestForm
            busy={busy}
            onCancel={() => {
              requestTag.current += 1;
              setRequesting(false);
            }}
            onRequest={async (target, dueDate) => {
              const tag = ++requestTag.current;
              let created: string | undefined;
              await action(async () => {
                const { ids } = await api.employeeForms.create(target, [
                  { dueDate, kind: "background_check", title },
                ]);
                created = ids[0];
              }, "Background check added.");
              if (created && tag === requestTag.current)
                onNavigate(backgroundCheckPath(created));
            }}
          />
        )}
        {!checks ? (
          loading ? (
            <LoadingState label="Loading background checks…" />
          ) : (
            <Banner
              actions={
                <Button onClick={() => void reload()} size="sm">
                  Try again
                </Button>
              }
              tone="danger"
            >
              {error ?? "Could not load background checks."}
            </Banner>
          )
        ) : (
          <PageSection
            actions={
              <span className="sectionCount">
                {countLabel(checks.length, "check")}
              </span>
            }
            title="Checks"
          >
            {checks.length === 0 ? (
              <EmptyState icon="userSearch" title="No background checks yet">
                Request one, and the person reviews Checkr’s disclosures and
                signs the authorization in {productName} before Checkr screens
                them.
              </EmptyState>
            ) : (
              <Card flush>
                <ul className="rowList">
                  {checks.map((check) => (
                    <BackgroundCheckRow
                      check={check}
                      key={check.id}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              </Card>
            )}
          </PageSection>
        )}
      </PageBody>
    </Page>
  );
}

function BackgroundCheckRow({
  check,
  onNavigate,
}: {
  check: EmployeeRequirement;
  onNavigate: (pathname: string) => void;
}) {
  const badge = requirementBadge(check);
  return (
    <ListRow
      icon="userSearch"
      meta={`${personNote(check)}Due ${formatCalendarDate(check.dueDate)}`}
      open={{ href: backgroundCheckPath(check.id), onNavigate }}
      title={check.targetName ?? check.targetEmail ?? "Unknown person"}
    >
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </ListRow>
  );
}

/** Why a check has no member page, when it hasn't. */
function personNote(check: EmployeeRequirement) {
  if (check.memberId) return "";
  return check.invitationId && check.invitationStatus === "pending"
    ? "Invited · "
    : "No longer a member · ";
}

type CheckTarget = { invitationId: string } | { memberId: string };

/** Who can be asked for a check: members, and invitees when they're listed. */
function useCheckTargets() {
  return useLoad(
    useCallback(async () => {
      const people = await api.organizationSettings.people();
      return [
        ...people.members.map((member) => ({
          label: member.user.name || member.user.email,
          value: `member:${member.id}`,
        })),
        // Invitations reach owners and admins only.
        ...people.invitations
          .filter(({ status }) => status === "pending")
          .map((invitation) => ({
            label: `${invitation.email} (invited)`,
            value: `invitation:${invitation.id}`,
          })),
      ];
    }, []),
    "Could not load people.",
  );
}

/** The person a picker value names: `member:<id>` or `invitation:<id>`. */
function targetFor(value: string): CheckTarget | undefined {
  const match = /^(member|invitation):(.+)$/.exec(value);
  if (!match?.[2]) return undefined;
  return match[1] === "member"
    ? { memberId: match[2] }
    : { invitationId: match[2] };
}

function BackgroundCheckRequestForm({
  busy,
  onCancel,
  onRequest,
}: {
  busy: boolean;
  onCancel: () => void;
  onRequest: (target: CheckTarget, dueDate: string) => Promise<void>;
}) {
  const paidFeaturesEnabled = usePaidFeaturesEnabled();
  const targets = useCheckTargets();
  const [person, setPerson] = useState("");
  const [dueDate, setDueDate] = useState("");
  const target = targetFor(person);
  const canSend = paidFeaturesEnabled && Boolean(target && dueDate);
  function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (canSend && target) void onRequest(target, dueDate);
  }
  return (
    <Card
      description="Add the check, then request it from Checkr on its page with the person’s work location."
      title="Request a background check"
    >
      {!paidFeaturesEnabled && (
        <Banner announce={false} icon="lock" tone="neutral">
          Paid features are disabled for this organization. An owner or admin
          can enable them in Organization settings.
        </Banner>
      )}
      {targets.error && <Toast tone="danger">{targets.error}</Toast>}
      <form className="requirementEditor" onSubmit={submit}>
        <div className="requirementEditorFields">
          <Field label="Person">
            <Select
              disabled={busy || !targets.data}
              onChange={(event) => setPerson(event.target.value)}
              value={person}
            >
              <option value="">
                {targets.data ? "Choose a person" : "Loading people…"}
              </option>
              {targets.data?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <input
              className="input"
              disabled={busy}
              onChange={(event) => setDueDate(event.target.value)}
              type="date"
              value={dueDate}
            />
          </Field>
        </div>
        <div className="formActions">
          <Button
            busy={busy}
            disabled={!canSend}
            type="submit"
            variant="primary"
          >
            Add check
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function BackgroundCheckPage({
  canManage,
  onNavigate,
  requirementId,
}: {
  canManage: boolean;
  onNavigate: (pathname: string) => void;
  requirementId: string;
}) {
  const { action, busy, error, loading, notice, reload, requirements } =
    useManagedRequirements();
  const check = requirements?.find(
    ({ id, kind }) => id === requirementId && isBackgroundCheck(kind),
  );
  return (
    <Page>
      <PageHeader
        back={
          <AppButtonLink
            href={backgroundCheckPath()}
            icon="arrowLeft"
            onNavigate={onNavigate}
            size="sm"
            variant="ghost"
          >
            Background checks
          </AppButtonLink>
        }
        description={check && (check.targetName ?? check.targetEmail)}
        eyebrow="Records"
        title={title}
      />
      <PageBody>
        {error && <Toast tone="danger">{error}</Toast>}
        {notice && <Toast tone="success">{notice}</Toast>}
        {!requirements ? (
          loading ? (
            <LoadingState label="Loading background check…" />
          ) : (
            <Banner
              actions={
                <Button onClick={() => void reload()} size="sm">
                  Try again
                </Button>
              }
              tone="danger"
            >
              {error ?? "Could not load the background check."}
            </Banner>
          )
        ) : !check ? (
          <EmptyState
            icon="userSearch"
            title="This background check isn’t here"
          >
            It may have been removed.
          </EmptyState>
        ) : (
          <RequirementSections
            action={action}
            busy={busy}
            linkPeople={canManage}
            onNavigate={onNavigate}
            requirement={check}
          />
        )}
      </PageBody>
    </Page>
  );
}
