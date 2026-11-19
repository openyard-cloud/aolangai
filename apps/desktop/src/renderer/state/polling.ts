import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEvent } from "@aolangai/core";
import { api } from "./store.js";
import { createEventFetcher } from "./eventFetcher.js";
import { latestStep } from "../view/runs.js";

const STEP_POLL_MS = 3000;

/** The current time, ticking every second while something runs (durations count up) and every 30 seconds otherwise. */
export function useNow(busy: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), busy ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);
  return now;
}

/**
 * Worker steps per run id, one owner for the lanes and the detail panel so a run is never polled twice. Steps are
 * not part of the pushed state: every running run is fetched when it first shows up and then every 3 seconds until
 * it stops running or the component unmounts; the run open in the detail panel is fetched when it opens (and once
 * more when it stops running). At most one request per run is in flight. Only a failure on the open run is
 * reported (once per run): a lane that cannot get steps just shows none.
 */
export function useRunEvents(runningIds: number[], openId: number | undefined, report: (e: unknown) => void): { events: Record<number, RunEvent[]>; steps: Record<number, string | undefined> } {
  const [events, setEvents] = useState<Record<number, RunEvent[]>>({});
  const openRef = useRef(openId);
  openRef.current = openId;
  const reportRef = useRef(report);
  reportRef.current = report;
  const reported = useRef(new Set<number>());
  const fetcher = useRef<ReturnType<typeof createEventFetcher>>(undefined);
  fetcher.current ??= createEventFetcher(
    (id) => api.runEvents(id),
    (id, list) => setEvents((prev) => ({ ...prev, [id]: list })),
    (id, e) => {
      if (id !== openRef.current || reported.current.has(id)) return;
      reported.current.add(id);
      reportRef.current(e);
    },
  );

  const key = runningIds.join(",");
  useEffect(() => {
    if (key === "") return;
    const ids = key.split(",").map(Number);
    const tick = () => ids.forEach((id) => fetcher.current?.fetch(id));
    tick();
    const t = setInterval(tick, STEP_POLL_MS);
    return () => clearInterval(t);
  }, [key]);

  const openIsRunning = openId !== undefined && runningIds.includes(openId);
  useEffect(() => {
    if (openId === undefined) return;
    reported.current.delete(openId);
    fetcher.current?.fetch(openId); // polling (above) takes over while it runs
  }, [openId, openIsRunning]);

  const steps = useMemo(() => Object.fromEntries(Object.entries(events).map(([id, list]) => [id, latestStep(list)])), [events]);
  return { events, steps };
}
