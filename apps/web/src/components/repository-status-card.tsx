"use client";

import {
  AlertTriangle,
  ArrowRight,
  Check,
  Circle,
  FileCode2,
  GitBranch,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";

import {
  repositoryFailureMessage,
  type RepositoryIndexingStatus,
} from "@/lib/api/repositories";
import { abbreviate, cn } from "@/lib/utils";

const stages = [
  { id: "cloning", label: "Clone" },
  { id: "scanning", label: "Scan" },
  { id: "chunking", label: "Chunk" },
  { id: "embedding", label: "Embed" },
  { id: "indexing", label: "Index" },
] as const;

const stageOrder: Record<string, number> = {
  pending: -1,
  queued: -1,
  cloning: 0,
  scanning: 1,
  parsing: 2,
  chunking: 2,
  embedding: 3,
  indexing: 4,
  completed: 5,
  ready: 5,
};

function statusTitle(status: RepositoryIndexingStatus): string {
  if (status.status === "ready") return "Repository is ready";
  if (status.status === "failed") return "Indexing needs attention";
  const step = status.job?.currentStep ?? status.status;
  const titles: Record<string, string> = {
    pending: "Preparing repository",
    queued: "Waiting for the indexing worker",
    cloning: "Cloning repository",
    scanning: "Scanning source files",
    parsing: "Splitting code into useful context",
    chunking: "Splitting code into useful context",
    embedding: "Generating semantic embeddings",
    indexing: "Saving the searchable index",
  };
  return titles[step] ?? "Indexing repository";
}

export function RepositoryStatusCard({
  status,
  retrying = false,
  onRetry,
  onImportAnother,
}: {
  status: RepositoryIndexingStatus;
  retrying?: boolean;
  onRetry?: () => void;
  onImportAnother?: () => void;
}) {
  const isReady = status.status === "ready";
  const isFailed = status.status === "failed";
  const progress = isReady
    ? 100
    : Math.min(99, Math.max(0, status.job?.progress ?? 0));
  const activeStep =
    stageOrder[status.job?.currentStep ?? status.status] ?? -1;

  return (
    <section className="overflow-hidden rounded-[28px] border border-[var(--line)] bg-white shadow-[0_22px_70px_rgba(14,27,24,0.08)]">
      <div className="p-5 sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-2xl",
                isReady && "bg-[#e6f4c9] text-[var(--accent-deep)]",
                isFailed && "bg-rose-100 text-rose-700",
                !isReady && !isFailed && "bg-[var(--ink)] text-[var(--accent)]",
              )}
            >
              {isReady ? (
                <Check aria-hidden="true" className="size-5" />
              ) : isFailed ? (
                <AlertTriangle aria-hidden="true" className="size-5" />
              ) : (
                <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
              )}
            </span>
            <div className="min-w-0">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted-strong)]">
                {isReady ? "AI access unlocked" : isFailed ? "Action required" : "Indexing in progress"}
              </p>
              <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.035em]">
                {statusTitle(status)}
              </h2>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                <span className="flex items-center gap-1.5">
                  <GitBranch aria-hidden="true" className="size-3.5" />
                  {status.selectedBranch}
                </span>
                <span className="flex items-center gap-1.5">
                  <FileCode2 aria-hidden="true" className="size-3.5" />
                  {status.stats.files} files · {status.stats.chunks} chunks
                </span>
                {status.lastIndexedCommit ? (
                  <span className="font-mono">
                    {abbreviate(status.lastIndexedCommit, 8)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <span className="w-fit rounded-full border border-[var(--line)] bg-[var(--surface-soft)] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
            {status.status}
          </span>
        </div>

        {!isFailed ? (
          <div className="mt-7">
            <div className="mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-strong)]">
              <span>{isReady ? "Complete" : "Processing"}</span>
              <span>{progress}%</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-[var(--surface-soft)]"
              role="progressbar"
              aria-label="Repository indexing progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="h-full rounded-full bg-[var(--accent-strong)] transition-[width] duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-950">
            <p className="text-xs font-semibold">Why it stopped</p>
            <p className="mt-1.5 text-xs leading-5 text-rose-800">
              {repositoryFailureMessage(status)}
            </p>
          </div>
        )}

        <ol className="mt-7 grid grid-cols-5 gap-1" aria-label="Indexing stages">
          {stages.map((stage, index) => {
            const complete = isReady || index < activeStep;
            const current = !isReady && !isFailed && index === activeStep;
            const failed = isFailed && index === activeStep;
            return (
              <li key={stage.id} className="min-w-0 text-center">
                <span
                  className={cn(
                    "mx-auto grid size-7 place-items-center rounded-full border",
                    complete && "border-[var(--accent-strong)] bg-[#e8f4d1] text-[var(--accent-deep)]",
                    current && "border-[var(--ink)] bg-[var(--ink)] text-[var(--accent)]",
                    failed && "border-rose-300 bg-rose-100 text-rose-700",
                    !complete && !current && !failed && "border-[var(--line)] bg-white text-[var(--muted-strong)]",
                  )}
                >
                  {complete ? (
                    <Check aria-hidden="true" className="size-3.5" />
                  ) : current ? (
                    <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                  ) : failed ? (
                    <AlertTriangle aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Circle aria-hidden="true" className="size-2.5" />
                  )}
                </span>
                <span className="mt-2 block truncate text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-strong)] sm:text-[10px]">
                  {stage.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--line)] bg-[var(--surface-soft)]/65 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="text-[11px] leading-5 text-[var(--muted)]">
          Repository <span className="font-mono">{status.repositoryId}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {onImportAnother ? (
            <button
              type="button"
              onClick={onImportAnother}
              className="h-9 rounded-xl border border-[var(--line)] bg-white px-3 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
            >
              Import another
            </button>
          ) : null}
          {isFailed && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--ink)] px-3 text-xs font-semibold text-[var(--accent)] transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)] disabled:cursor-wait disabled:opacity-60"
            >
              <RotateCcw aria-hidden="true" className={cn("size-3.5", retrying && "animate-spin")} />
              {retrying ? "Queuing…" : "Retry indexing"}
            </button>
          ) : null}
          {isReady ? (
            <Link
              href={`/repositories/${status.repositoryId}/chat`}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--ink)] px-3 text-xs font-semibold text-[var(--accent)] transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            >
              Open AI chat
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
