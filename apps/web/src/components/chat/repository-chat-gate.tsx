"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Braces, CircleAlert, GitFork, LockKeyhole } from "lucide-react";
import Link from "next/link";

import { RepositoryChat } from "@/components/chat/repository-chat";
import { RepositoryStatusCard } from "@/components/repository-status-card";
import { ApiError, apiErrorMessage, githubSignInUrl } from "@/lib/api/client";
import {
  getRepositoryStatus,
  isRepositoryProcessing,
  retryRepositoryIndexing,
} from "@/lib/api/repositories";

export function RepositoryChatGate({ repositoryId }: { repositoryId: string }) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["repository-status", repositoryId],
    queryFn: () => getRepositoryStatus(repositoryId),
    retry(failureCount, error) {
      return !(error instanceof ApiError && error.status < 500) && failureCount < 2;
    },
    refetchInterval(query) {
      const status = query.state.data?.status;
      return status && isRepositoryProcessing(status) ? 2_000 : false;
    },
  });
  const retryMutation = useMutation({
    mutationFn: () => retryRepositoryIndexing(repositoryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["repository-status", repositoryId],
      });
    },
  });

  if (statusQuery.data?.status === "ready") {
    return <RepositoryChat repositoryId={repositoryId} />;
  }

  const unauthenticated =
    statusQuery.error instanceof ApiError && statusQuery.error.status === 401;

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-3 px-5 sm:px-8">
          <Link
            href="/repositories"
            aria-label="Back to repositories"
            className="grid size-9 place-items-center rounded-xl border border-[var(--line)] bg-white text-[var(--muted)]"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </Link>
          <span className="grid size-9 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)]">
            <Braces aria-hidden="true" className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">Repository chat</p>
            <p className="font-mono text-[10px] text-[var(--muted)]">Access check</p>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-12 sm:px-8 sm:py-16">
        {statusQuery.isPending ? (
          <div className="h-80 animate-pulse rounded-[28px] border border-[var(--line)] bg-white" />
        ) : unauthenticated ? (
          <section className="mx-auto max-w-lg rounded-[28px] border border-[var(--line)] bg-white p-8 text-center shadow-[0_22px_70px_rgba(14,27,24,0.08)]">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--ink)] text-[var(--accent)]">
              <LockKeyhole aria-hidden="true" className="size-5" />
            </span>
            <h1 className="mt-6 text-2xl font-semibold tracking-[-0.04em]">Sign in before opening chat</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
              The API must verify that this repository belongs to your account before any model request is allowed.
            </p>
            <a href={githubSignInUrl()} className="mt-7 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] text-sm font-semibold text-white">
              <GitFork aria-hidden="true" className="size-4" />
              Sign in with GitHub
            </a>
          </section>
        ) : statusQuery.isError ? (
          <section role="alert" className="rounded-[28px] border border-rose-200 bg-white p-7 shadow-[0_22px_70px_rgba(14,27,24,0.08)]">
            <CircleAlert aria-hidden="true" className="size-5 text-rose-700" />
            <h1 className="mt-4 text-xl font-semibold">Chat cannot be opened</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              {apiErrorMessage(statusQuery.error, "Repository access could not be verified.")}
            </p>
            <Link href="/repositories" className="mt-5 inline-flex h-10 items-center rounded-xl bg-[var(--ink)] px-4 text-xs font-semibold text-[var(--accent)]">
              Return to repositories
            </Link>
          </section>
        ) : (
          <>
            <div className="mb-7 rounded-2xl border border-[#dce8bd] bg-[#f0f7df] p-4">
              <div className="flex gap-3">
                <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--accent-deep)]" />
                <div>
                  <h1 className="text-sm font-semibold">AI chat is locked for now</h1>
                  <p className="mt-1 text-xs leading-5 text-[#5c694c]">
                    The composer and starter questions are not mounted until the API confirms a complete index.
                  </p>
                </div>
              </div>
            </div>
            <RepositoryStatusCard
              status={statusQuery.data}
              retrying={retryMutation.isPending}
              onRetry={() => retryMutation.mutate()}
            />
            {retryMutation.isError ? (
              <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                {apiErrorMessage(retryMutation.error, "Indexing could not be retried.")}
              </p>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
