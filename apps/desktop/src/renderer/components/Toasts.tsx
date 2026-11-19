import type { Toast } from "../view/format.js";

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span>{t.text}</span>
          <button className="small" onClick={() => onDismiss(t.id)} aria-label="Close notification">Close</button>
        </div>
      ))}
    </div>
  );
}
