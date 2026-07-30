"use client";

import { Check, Copy, FileCode2 } from "lucide-react";
import { useState } from "react";

import type { RepositoryAnswerSource } from "@/lib/api/repository-chat";

export function sourceCitation(source: RepositoryAnswerSource): string {
  return `[${source.filePath}:L${source.startLine}-L${source.endLine}]`;
}

export function SourceCard({
  source,
  index,
}: {
  source: RepositoryAnswerSource;
  index: number;
}) {
  const [copied, setCopied] = useState(false);
  const citation = sourceCitation(source);

  async function copyCitation() {
    try {
      await navigator.clipboard.writeText(citation);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="group rounded-xl border border-[var(--line)] bg-[var(--surface-soft)]/55 p-3.5 transition hover:border-[var(--line-strong)] hover:bg-[var(--surface-soft)]">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-[var(--line)] bg-white text-[var(--accent-deep)]">
          <FileCode2 aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-strong)]">
              Source {index + 1}
            </span>
            <span className="h-px flex-1 bg-[var(--line)]" />
          </div>
          <p className="mt-1.5 truncate font-mono text-xs font-semibold text-[var(--ink)]">
            {source.filePath}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
            <span className="rounded-md border border-[var(--line)] bg-white px-2 py-1 font-mono">
              L{source.startLine}–L{source.endLine}
            </span>
            {source.symbolName ? (
              <span className="max-w-full truncate rounded-md border border-[var(--line)] bg-white px-2 py-1 font-mono">
                {source.symbolName}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void copyCitation()}
          aria-label={`Copy citation for ${source.filePath}`}
          title="Copy citation"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition hover:bg-white hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-[var(--accent-deep)]" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </div>
    </article>
  );
}
