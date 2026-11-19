import type { MainApi } from "./ipc.js";

export interface MaintenanceOptions {
  intervalMs: number;
  /** How often open sessions are rescanned. */
  sessionsMs: number;
  /** Default: console.error. */
  log?: (line: string) => void;
}

/**
 * Wraps calls that must never throw out of a timer or startup: a failure (SQLITE_BUSY after the timeout, a closing
 * store) is logged once while the same message repeats, and the caller simply tries again next time.
 */
function guards(log: (line: string) => void) {
  let lastLogged: string | undefined;
  const failed = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== lastLogged) {
      lastLogged = message;
      log(`[aolangai] ${message}`);
    }
  };
  return {
    sync:
      <T>(fn: () => T): T | undefined => {
        try {
          const out = fn();
          lastLogged = undefined;
          return out;
        } catch (e) {
          failed(e);
          return undefined;
        }
      },
    /** For a promise-returning call: both a synchronous throw and a rejection end up in the log, never unhandled. */
    async: async (fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
        lastLogged = undefined;
      } catch (e) {
        failed(e);
      }
    },
  };
}

/**
 * Sweeps for dead runs now and every `intervalMs`, rescans open sessions now and every `sessionsMs`, and sends the first state. Nothing in here throws. `pushState` is
 * the guarded one for other callers (the store watcher). `stop` ends both timers.
 */
export function startMaintenance(api: Pick<MainApi, "sweep" | "pushState" | "scan">, o: MaintenanceOptions): { pushState(): void; stop(): void } {
  const log = o.log ?? ((line) => console.error(line));
  const sweepGuard = guards(log).sync;
  const pushGuard = guards(log).sync;
  const scanGuard = guards(log).async;
  const sweep = () => void sweepGuard(() => api.sweep());
  const pushState = () => void pushGuard(() => api.pushState());
  const scan = () => void scanGuard(() => api.scan());
  sweep();
  pushState();
  scan();
  const sweepTimer = setInterval(sweep, o.intervalMs);
  const scanTimer = setInterval(scan, o.sessionsMs);
  return {
    pushState,
    stop: () => {
      clearInterval(sweepTimer);
      clearInterval(scanTimer);
    },
  };
}
