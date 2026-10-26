import { Button } from "@balebase/ui/react";
import type { JobRun } from "@balebase/validators/adminJobs";
import { useId } from "react";
import { AdminJobRun } from "./AdminJobRun";

export function AdminJobHistoryRow({
  expanded,
  name,
  onToggle,
  run,
}: {
  expanded: boolean;
  name: string;
  onToggle: () => void;
  run: JobRun;
}) {
  const detailId = useId();
  const triggerId = `${detailId}-trigger`;
  const createdAt = new Date(run.createdAt).toLocaleString();
  return (
    <div className="adminJobHistoryItem">
      <div className="adminJobRow">
        <div className="adminJobSummary">
          <strong>{name}</strong>
          <p className="textSm textSubtle">
            {run.status} · {run.source} · {createdAt}
          </p>
          {run.organizationId && (
            <p className="textSm">Organization: {run.organizationId}</p>
          )}
        </div>
        <Button
          aria-controls={detailId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "View"} run for ${name} from ${createdAt}`}
          id={triggerId}
          onClick={onToggle}
        >
          {expanded ? "Hide run" : "View run"}
        </Button>
      </div>
      <section aria-labelledby={triggerId} hidden={!expanded} id={detailId}>
        {expanded && <AdminJobRun runId={run.runId} />}
      </section>
    </div>
  );
}
