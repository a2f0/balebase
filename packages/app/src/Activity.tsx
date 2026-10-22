import { Field, Page, PageBody, PageHeader } from "@balebase/ui/react";
import type { ActivityResourceType } from "@balebase/validators/activity";
import { useEffect, useState } from "react";
import { ActivityFeed } from "./ActivityFeed";

const resourceLabels: Record<ActivityResourceType, string> = {
  audit_run: "Audits",
  audit_template: "Forms",
  issue: "Workspace issues",
  equipment: "Equipment",
  organization_member: "People",
  api_key: "API keys",
  finance_transaction: "Transactions",
};

function isResourceType(value: string): value is ActivityResourceType {
  return Object.hasOwn(resourceLabels, value);
}

export function Activity({
  onNavigate,
  canAccessFinance = false,
}: {
  onNavigate: (pathname: string) => void;
  canAccessFinance?: boolean;
}) {
  const [selected, setSelected] = useState<ActivityResourceType>();
  useEffect(() => {
    if (!canAccessFinance)
      setSelected((previous) =>
        previous === "finance_transaction" ? undefined : previous,
      );
  }, [canAccessFinance]);
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
            onChange={(event) => {
              const value = event.target.value;
              setSelected(isResourceType(value) ? value : undefined);
            }}
          >
            <option value="">All resources</option>
            {Object.entries(resourceLabels)
              .filter(
                ([value]) =>
                  canAccessFinance || value !== "finance_transaction",
              )
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </select>
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
