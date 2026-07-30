import { SearchCode } from "lucide-react";

export function AnswerProgress() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="message-enter flex max-w-2xl items-center gap-3 rounded-2xl border border-[var(--line)] bg-white px-4 py-3.5 shadow-[0_8px_28px_rgba(14,27,24,0.05)]"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)]">
        <SearchCode aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--ink)]">
          Searching the indexed repository
        </p>
        <p className="mt-0.5 text-xs text-[var(--muted)]">
          Retrieving related code and preparing a cited explanation.
        </p>
      </div>
      <span className="flex gap-1" aria-hidden="true">
        <span className="thinking-dot size-1.5 rounded-full bg-[var(--accent-strong)]" />
        <span className="thinking-dot size-1.5 rounded-full bg-[var(--accent-strong)]" />
        <span className="thinking-dot size-1.5 rounded-full bg-[var(--accent-strong)]" />
      </span>
    </div>
  );
}
