import type { JobRun } from "@balebase/validators/adminJobs";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./apiClient";

type History = Awaited<ReturnType<typeof api.adminJobs.runs>>;
type Query = Parameters<typeof api.adminJobs.runs>[0];
type HistoryState = {
  data?: History;
  error?: string | undefined;
  loadMoreError?: string | undefined;
  loadingMore: boolean;
  refreshing: boolean;
};
const initialState: HistoryState = { loadingMore: false, refreshing: false };

export function useJobHistory(jobId: string, status: JobRun["status"] | "") {
  const [state, setState] = useState(initialState);
  const nextPage = useRef<() => Promise<void>>(undefined);
  useEffect(() => {
    setState(initialState);
    const loader = historyLoader(
      { ...(jobId ? { jobId } : {}), ...(status ? { status } : {}) },
      (update) => setState((current) => ({ ...current, ...update })),
    );
    nextPage.current = loader.loadMore;
    loader.start();
    return loader.stop;
  }, [jobId, status]);
  const loadMore = useCallback(async () => {
    await nextPage.current?.();
  }, []);
  return { ...state, loadMore };
}

function historyLoader(
  query: Query,
  publish: (state: Partial<HistoryState>) => void,
) {
  let active = true;
  let busy = false;
  let data: History | undefined;
  let pageCount = 1;
  let timer: ReturnType<typeof setTimeout>;
  async function load(cursor?: string) {
    if (!active || busy) return;
    busy = true;
    clearTimeout(timer);
    publish({ loadingMore: Boolean(cursor), refreshing: !cursor });
    try {
      if (cursor) {
        const next = await api.adminJobs.runs({ ...query, cursor });
        if (!active) return;
        data = {
          ...next,
          runs: uniqueRuns([...(data?.runs ?? []), ...next.runs]),
        };
        pageCount++;
        publish({ data, loadMoreError: undefined });
      } else {
        const refreshed = await refreshHistory(
          query,
          data?.runs.at(-1),
          () => active,
        );
        if (!active) return;
        data = refreshed.data;
        pageCount = refreshed.pageCount;
        publish({ data, error: undefined });
      }
    } catch (cause) {
      if (!active) return;
      const message = historyError(cause);
      publish(cursor ? { loadMoreError: message } : { error: message });
    } finally {
      busy = false;
      if (active) {
        publish({ loadingMore: false, refreshing: false });
        // Keep polling traffic proportional to time, even after many pages load.
        timer = setTimeout(() => void load(), 5000 * pageCount);
      }
    }
  }
  return {
    start: () => void load(),
    loadMore: async () => {
      if (data?.nextCursor) await load(data.nextCursor);
    },
    stop: () => {
      active = false;
      clearTimeout(timer);
    },
  };
}

/** Refresh through the oldest loaded row so new runs never drop the reader's place. */
async function refreshHistory(
  query: Query,
  oldest: JobRun | undefined,
  active: () => boolean,
) {
  const data = await api.adminJobs.runs(query);
  let pageCount = 1;
  while (
    active() &&
    data.nextCursor &&
    oldest &&
    newerThan(data.runs.at(-1), oldest)
  ) {
    const next = await api.adminJobs.runs({
      ...query,
      cursor: data.nextCursor,
    });
    data.runs.push(...next.runs);
    data.nextCursor = next.nextCursor;
    pageCount++;
  }
  data.runs = uniqueRuns(data.runs);
  return { data, pageCount };
}

function newerThan(run: JobRun | undefined, boundary: JobRun) {
  return (
    run &&
    (run.createdAt > boundary.createdAt ||
      (run.createdAt === boundary.createdAt && run.runId > boundary.runId))
  );
}

function uniqueRuns(runs: JobRun[]) {
  return [...new Map(runs.map((run) => [run.runId, run])).values()];
}

function historyError(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load job history.";
}
