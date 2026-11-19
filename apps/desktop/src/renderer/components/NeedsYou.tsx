import type { Account } from "@aolangai/core";
import { attentionLine, type Attention } from "../view/runs.js";

export interface NeedsYouProps {
  items: Attention[];
  accounts: Account[];
  onRetry(runId: number): void;
  onOpen(runId: number): void;
  onOpenSettings(accountId: string): void;
}

const ICON = { failed: "failed", limited: "limited", denied: "denied", reserve: "reserve" } as const;

/** The "Needs you" block: one row per thing that needs a look, with its buttons. Hidden when there is nothing. */
export function NeedsYou({ items, accounts, onRetry, onOpen, onOpenSettings }: NeedsYouProps) {
  if (items.length === 0) return null;
  return (
    <section className="needs" id="needs-you">
      <h2>Needs you</h2>
      {items.map((a) => {
        const line = attentionLine(a, accounts);
        // Retry and settings.json need the account; for a deleted one only the detail panel (which can retry by the normal rule) is offered.
        const hasAccount = a.kind !== "reserve" && accounts.some((x) => x.id === a.run.accountId);
        const open = a.kind === "reserve" ? undefined : () => onOpen(a.run.id);
        return (
          <div key={a.kind === "reserve" ? `reserve:${a.account.id}` : `${a.kind}:${a.run.id}`} className={`need-row ${a.kind}`}>
            <span className="need-tag">{ICON[a.kind]}</span>
            {/* The line is the click target for the detail panel; it is not a button so the row keeps exactly its own buttons. */}
            <span className="need-text" title={line} role={open ? "link" : undefined} tabIndex={open ? 0 : undefined} onClick={open} onKeyDown={(e) => e.key === "Enter" && open?.()}>
              {line}
            </span>
            <span className="actions">
              {a.kind !== "reserve" && (a.kind === "denied" || !hasAccount) && <button onClick={() => onOpen(a.run.id)}>View</button>}
              {hasAccount && (a.kind === "failed" || a.kind === "limited") && <button onClick={() => onRetry(a.run.id)}>Retry</button>}
              {hasAccount && a.kind === "denied" && <button onClick={() => onOpenSettings(a.run.accountId)}>Open settings.json</button>}
            </span>
          </div>
        );
      })}
    </section>
  );
}
