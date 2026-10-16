import { Page, PageBody, PageHeader } from "@balebase/ui/react";
import { ActivityFeed } from "./ActivityFeed";

export function Activity({
  onNavigate,
}: {
  onNavigate: (pathname: string) => void;
}) {
  return (
    <Page>
      <PageHeader
        description="See who changed forms, audits, equipment, and roles in this organization."
        eyebrow="Workspace"
        title="Activity"
      />
      <PageBody>
        <ActivityFeed compact onNavigate={onNavigate} />
      </PageBody>
    </Page>
  );
}
