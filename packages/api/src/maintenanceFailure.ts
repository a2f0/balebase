import type { JobOutput } from "@balebase/validators/adminJobs";

/** Preserve completed work's counters when a maintenance batch partly fails. */
export class MaintenanceFailure extends Error {
  constructor(
    readonly output: JobOutput,
    cause: unknown,
  ) {
    super("Maintenance did not complete for every item.", { cause });
  }
}
