import { useCallback, useEffect, useRef, useState } from "react";
import { API_METHODS, type AppApi, type AppState } from "../../shared/api.js";
import { addToast, errorText, type Toast } from "../view/format.js";

/** The main process as the renderer sees it; every call is an IPC round trip that may reject with a message. */
export const api: AppApi = Object.fromEntries(
  API_METHODS.map((m) => [m, (...args: unknown[]) => (window.aolangai.invoke as (m: string, ...a: unknown[]) => Promise<unknown>)(m, ...args)]),
) as unknown as AppApi;

/** How a component tells the human something: an error from a failed call, or a plain confirmation. */
export interface Feedback {
  report(e: unknown): void;
  notify(text: string): void;
}

const TOAST_MS = 8000;

export function useToasts(): { toasts: Toast[]; feedback: Feedback; dismiss(id: number): void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"]) => {
    const id = ++seq.current;
    setToasts((list) => addToast(list, text, id, tone));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
  }, []);
  const feedback = useRef<Feedback>({ report: (e) => push(errorText(e), "error"), notify: (text) => push(text, "info") });
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  return { toasts, feedback: feedback.current, dismiss };
}

/** Notices from the main process (e.g. a retry the CLI refused), shown as error toasts. */
export function useNotices(report: Feedback["report"]): void {
  useEffect(() => window.aolangai.onNotice((n) => report(n.body)), [report]);
}

/** The shared state: loaded once, then replaced by every push from the main process. */
export function useAppState(report: Feedback["report"]): { state: AppState | null; refresh(): void } {
  const [state, setState] = useState<AppState | null>(null);
  const pushed = useRef(false);
  const refresh = useCallback(() => void api.getState().then((s) => !pushed.current && setState(s)).catch(report), [report]);
  useEffect(() => {
    const off = window.aolangai.onState((s) => {
      pushed.current = true;
      setState(s);
    });
    refresh();
    return off;
  }, [refresh]);
  return { state, refresh };
}
