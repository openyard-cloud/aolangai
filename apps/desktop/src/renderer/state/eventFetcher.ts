import type { RunEvent } from "@aolangai/core";

/**
 * Fetches the steps of runs, at most one request per run at a time: a call for a run whose previous request has
 * not answered yet is dropped. That also means answers for one run arrive in the order they were asked, so an
 * older answer can never overwrite a newer one.
 */
export function createEventFetcher(
  load: (runId: number) => Promise<RunEvent[]>,
  apply: (runId: number, events: RunEvent[]) => void,
  onError: (runId: number, e: unknown) => void,
): { fetch(runId: number): void } {
  const inFlight = new Set<number>();
  return {
    fetch(runId) {
      if (inFlight.has(runId)) return;
      inFlight.add(runId);
      load(runId)
        .then((events) => apply(runId, events))
        .catch((e) => onError(runId, e))
        .finally(() => inFlight.delete(runId));
    },
  };
}
