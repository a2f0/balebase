import type { JobDefinition, JobRun } from "@balebase/validators/adminJobs";
import { useCallback } from "react";
import { balebase } from "../balebase";
import { useLoad } from "../shared/useLoad";

/** The job catalog, which a schedule change updates in place. */
export function useJobCatalog() {
  const loaded = useLoad(
    useCallback(() => balebase().api.adminJobs.list(), []),
    "Could not load jobs.",
  );
  const { setData } = loaded;
  const replaceJob = useCallback(
    (job: JobDefinition) =>
      setData((jobs) =>
        jobs?.map((current) => (current.id === job.id ? job : current)),
      ),
    [setData],
  );
  return { ...loaded, replaceJob };
}

/** A requested run, numbered so each request reopens the history. */
export interface StartedRun {
  request: number;
  run: JobRun;
}
