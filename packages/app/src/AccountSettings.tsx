import {
  Button,
  Card,
  Field,
  Page,
  PageBody,
  PageHeader,
  Select,
  Toast,
} from "@balebase/ui/react";
import { type FormEvent, useState } from "react";
import { AccountDeletion } from "./AccountDeletion";
import { AccountSecurity } from "./AccountSecurity";
import { AppLink } from "./AppLink";
import { saveDefaultOrganizationPreference } from "./defaultOrganization";
import type { WorkspaceOrganization } from "./organizationState";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { useAction } from "./useAction";

export function AccountSettings({
  defaultOrganizationId,
  onNavigate,
  onSessionChanged,
  organizations,
  pathname,
  twoFactorEnabled,
}: {
  defaultOrganizationId: string | null | undefined;
  onNavigate: (pathname: string) => void;
  onSessionChanged: () => Promise<unknown>;
  organizations: WorkspaceOrganization[];
  pathname: string;
  twoFactorEnabled: boolean;
}) {
  const security = pathname === "/account/security";
  return (
    <Page narrow>
      <PageHeader
        description={
          security
            ? "Protect your account with a second step at sign-in."
            : "Choose how your account opens and looks."
        }
        eyebrow="Account"
        tabs={
          <>
            <AccountTab
              active={!security}
              label="General"
              onNavigate={onNavigate}
              path="/account"
            />
            <AccountTab
              active={security}
              label="Security"
              onNavigate={onNavigate}
              path="/account/security"
            />
          </>
        }
        tabsLabel="Account settings"
        title="Account settings"
      />
      <PageBody>
        {security ? (
          <AccountSecurity
            onSecurityChanged={onSessionChanged}
            twoFactorEnabled={twoFactorEnabled}
          />
        ) : (
          <AccountGeneral
            defaultOrganizationId={defaultOrganizationId}
            onSessionChanged={onSessionChanged}
            organizations={organizations}
          />
        )}
      </PageBody>
    </Page>
  );
}

function AccountTab({
  active,
  label,
  onNavigate,
  path,
}: {
  active: boolean;
  label: string;
  onNavigate: (pathname: string) => void;
  path: string;
}) {
  return (
    <AppLink
      aria-current={active ? "page" : undefined}
      className="tab"
      href={path}
      onNavigate={onNavigate}
    >
      {label}
    </AppLink>
  );
}

function AccountGeneral({
  defaultOrganizationId,
  onSessionChanged,
  organizations,
}: {
  defaultOrganizationId: string | null | undefined;
  onSessionChanged: () => Promise<unknown>;
  organizations: WorkspaceOrganization[];
}) {
  const current = organizations.some(({ id }) => id === defaultOrganizationId)
    ? defaultOrganizationId
    : organizations[0]?.id;
  // Follows the saved default until the person picks another.
  const [choice, setChoice] = useState<string>();
  const selected = choice ?? current ?? "";
  const {
    busy: saving,
    error,
    notice,
    run,
    setError,
    setNotice,
  } = useAction("Could not save your default organization.");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const saved = await run(
      () => saveDefaultOrganizationPreference(selected, onSessionChanged),
      "Default organization saved.",
    );
    if (saved) setChoice(undefined);
  }

  return (
    <>
      <Card
        description="This organization opens when you sign in."
        footer={
          <Button
            busy={saving}
            disabled={saving || !selected}
            type="submit"
            variant="primary"
          >
            Save changes
          </Button>
        }
        onSubmit={(event) => void save(event)}
        title="Default organization"
      >
        <Field label="Organization">
          <Select
            disabled={saving || organizations.length === 0}
            onChange={(event) => {
              setChoice(event.target.value);
              setError(undefined);
              setNotice(undefined);
            }}
            value={selected}
          >
            {organizations.length === 0 && (
              <option value="">No organizations available</option>
            )}
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {error && <Toast tone="danger">{error}</Toast>}
      {notice && <Toast tone="success">{notice}</Toast>}
      <Card
        description="Match your system, or keep Balebase light or dark on this device."
        title="Appearance"
      >
        <ThemeSwitcher className="appearanceTheme" />
      </Card>
      <AccountDeletion />
    </>
  );
}
