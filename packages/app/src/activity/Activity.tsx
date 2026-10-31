import { Field, Page, PageBody, PageHeader, Select } from "@balebase/ui/react";
import type { ActivityResourceType } from "@balebase/validators/activity";
import { useEffect, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";

const resourceLabels: Record<ActivityResourceType, string> = {
  audit_run: "Audits",
  audit_template: "Forms",
  issue: "Workspace issues",
  equipment: "Equipment",
  project: "Projects",
  organization_member: "People",
  organization_group: "Groups",
  api_key: "API keys",
  finance_transaction: "Transactions",
  finance_connection: "Bank connections",
  finance_category: "Expense categories",
  organization_billing: "Billing",
};

function isResourceType(value: string): value is ActivityResourceType {
  return Object.hasOwn(resourceLabels, value);
}

/** Finance resources need Finance access; groups and billing need a manager. */
function canFilter(
  value: string,
  access: { canAccessFinance: boolean; canManage: boolean },
) {
  if (value.startsWith("finance_")) return access.canAccessFinance;
  if (value === "organization_group" || value === "organization_billing")
    return access.canManage;
  return true;
}

export function Activity({
  onNavigate,
  canAccessFinance = false,
  canManage = false,
}: {
  onNavigate: (pathname: string) => void;
  canAccessFinance?: boolean;
  canManage?: boolean;
}) {
  const [selected, setSelected] = useState<ActivityResourceType>();
  useEffect(() => {
    setSelected((previous) =>
      previous && !canFilter(previous, { canAccessFinance, canManage })
        ? undefined
        : previous,
    );
  }, [canAccessFinance, canManage]);
  const resourceType =
    selected && canFilter(selected, { canAccessFinance, canManage })
      ? selected
      : undefined;
  return (
    <Page>
      <PageHeader
        description="Review who changed what and when across your organization. Filter by resource to follow its audit trail."
        eyebrow="Workspace"
        title="Activity"
      />
      <PageBody>
        <Field label="Resource" className="activityFilter">
          <Select
            value={resourceType ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setSelected(isResourceType(value) ? value : undefined);
            }}
          >
            <option value="">All resources</option>
            {Object.entries(resourceLabels)
              .filter(([value]) =>
                canFilter(value, { canAccessFinance, canManage }),
              )
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </Select>
        </Field>
        <ActivityFeed
          compact
          onNavigate={onNavigate}
          resourceType={resourceType}
        />
      </PageBody>
    </Page>
  );
}
