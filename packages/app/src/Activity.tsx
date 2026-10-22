import { Field, Page, PageBody, PageHeader } from "@balebase/ui/react";
import type { ActivityResourceType } from "@balebase/validators/activity";
import { useState } from "react";
import { ActivityFeed } from "./ActivityFeed";

export function Activity({
  onNavigate,
  canAccessFinance = false,
}: {
  onNavigate: (pathname: string) => void;
  canAccessFinance?: boolean;
}) {
  const [selected, setSelected] = useState<ActivityResourceType>();
  const resourceType =
    selected === "finance_transaction" && !canAccessFinance
      ? undefined
      : selected;
  return (
    <Page>
      <PageHeader
        description="Review who changed what and when across your organization. Filter by resource to follow its audit trail."
        eyebrow="Workspace"
        title="Activity"
      />
      <PageBody>
        <Field label="Resource" className="activityFilter">
          <select
            className="select"
            value={resourceType ?? ""}
            onChange={(event) =>
              setSelected(
                (event.target.value || undefined) as
                  | ActivityResourceType
                  | undefined,
              )
            }
          >
            <option value="">All resources</option>
            <option value="audit_run">Audits</option>
            <option value="audit_template">Forms</option>
            <option value="issue">Workspace issues</option>
            <option value="equipment">Equipment</option>
            <option value="organization_member">People</option>
            <option value="api_key">API keys</option>
            {canAccessFinance && (
              <option value="finance_transaction">Transactions</option>
            )}
          </select>
        </Field>
        <ActivityFeed
          compact
          key={resourceType ?? "all"}
          onNavigate={onNavigate}
          resourceType={resourceType}
        />
      </PageBody>
    </Page>
  );
}
