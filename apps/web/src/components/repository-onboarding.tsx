"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Braces,
  CircleAlert,
  GitFork,
  GitPullRequestArrow,
  LogOut,
  ServerCog,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";

import { RepositoryStatusCard } from "@/components/repository-status-card";
import { getCurrentUserOrNull, logout } from "@/lib/api/auth";
import { ApiError, apiErrorMessage, githubSignInUrl } from "@/lib/api/client";
import {
  getRepositoryStatus,
  importRepository,
  isRepositoryProcessing,
  retryRepositoryIndexing,
} from "@/lib/api/repositories";

const activeRepositoryStorageKey = "codebase-explainer.active-repository";

function subscribeToActiveRepository(onStoreChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === activeRepositoryStorageKey) onStoreChange();
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}

function activeRepositorySnapshot(): string {
  return window.localStorage.getItem(activeRepositoryStorageKey) ?? "";
}

function activeRepositoryServerSnapshot(): string {
  return "";
}

function isGitHubRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      parts.length === 2
    );
  } catch {
    return false;
  }
}

export function RepositoryOnboarding() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [formError, setFormError] = useState<string>();
  const storedRepositoryId = useSyncExternalStore(
    subscribeToActiveRepository,
    activeRepositorySnapshot,
    activeRepositoryServerSnapshot,
  );
  const [repositoryOverride, setRepositoryOverride] = useState<
    string | null | undefined
  >();
  const activeRepositoryId =
    repositoryOverride === undefined
      ? storedRepositoryId || undefined
      : repositoryOverride ?? undefined;

  const userQuery = useQuery({
    queryKey: ["current-user"],
    queryFn: getCurrentUserOrNull,
    retry: false,
  });
  const statusQuery = useQuery({
    queryKey: ["repository-status", activeRepositoryId],
    queryFn: () => getRepositoryStatus(activeRepositoryId as string),
    enabled: Boolean(userQuery.data) && Boolean(activeRepositoryId),
    retry(failureCount, error) {
      return !(error instanceof ApiError && error.status < 500) && failureCount < 2;
    },
    refetchInterval(query) {
      const status = query.state.data?.status;
      return status && isRepositoryProcessing(status) ? 2_000 : false;
    },
  });
  const importMutation = useMutation({
    mutationFn: importRepository,
    onSuccess(result) {
      window.localStorage.setItem(
        activeRepositoryStorageKey,
        result.repositoryId,
      );
      setRepositoryOverride(result.repositoryId);
      setFormError(undefined);
    },
  });
  const retryMutation = useMutation({
    mutationFn: retryRepositoryIndexing,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["repository-status", activeRepositoryId],
      });
    },
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled() {
      queryClient.clear();
      router.push("/auth");
    },
  });

  function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedUrl = repositoryUrl.trim();
    if (!isGitHubRepositoryUrl(normalizedUrl)) {
      setFormError("Enter a full public GitHub URL such as https://github.com/owner/repository.");
      return;
    }
    setFormError(undefined);
    importMutation.mutate({
      repositoryUrl: normalizedUrl,
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    });
  }

  function importAnother() {
    window.localStorage.removeItem(activeRepositoryStorageKey);
    setRepositoryOverride(null);
    setRepositoryUrl("");
    setBranch("");
    importMutation.reset();
    retryMutation.reset();
  }

  const unauthenticated = userQuery.isSuccess && userQuery.data === null;

  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)] bg-[var(--canvas)]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)]">
              <Braces aria-hidden="true" className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-[-0.02em]">Codebase Explainer</p>
              <p className="hidden text-[10px] text-[var(--muted)] sm:block">Repository workspace</p>
            </div>
          </Link>
          {userQuery.data ? (
            <div className="flex items-center gap-2">
              {/* GitHub avatar URL is supplied by the authenticated account. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={userQuery.data.avatarUrl}
                alt=""
                className="size-8 rounded-full border border-[var(--line)] bg-white"
              />
              <span className="hidden text-xs font-semibold sm:inline">@{userQuery.data.username}</span>
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
                aria-label="Sign out"
                className="grid size-9 place-items-center rounded-xl border border-[var(--line)] bg-white text-[var(--muted)] transition hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
              >
                <LogOut aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
        {userQuery.isPending ? (
          <div className="mx-auto max-w-3xl space-y-4">
            <div className="h-8 w-64 animate-pulse rounded-lg bg-[var(--line)]" />
            <div className="h-64 animate-pulse rounded-[28px] bg-white" />
          </div>
        ) : unauthenticated ? (
          <section className="mx-auto max-w-lg rounded-[28px] border border-[var(--line)] bg-white p-7 text-center shadow-[0_22px_70px_rgba(14,27,24,0.08)] sm:p-9">
            <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--ink)] text-[var(--accent)]">
              <GitFork aria-hidden="true" className="size-5" />
            </span>
            <h1 className="mt-6 text-2xl font-semibold tracking-[-0.04em]">Sign in to import a repository</h1>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
              Authentication happens here in the interface. You never need to open an API route manually.
            </p>
            <a
              href={githubSignInUrl()}
              className="mt-7 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-4 text-sm font-semibold text-white"
            >
              <GitFork aria-hidden="true" className="size-4" />
              Sign in with GitHub
            </a>
          </section>
        ) : userQuery.isError ? (
          <div role="alert" className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
            {apiErrorMessage(userQuery.error, "Your session could not be checked.")}
          </div>
        ) : activeRepositoryId ? (
          <div className="mx-auto max-w-4xl">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.17em] text-[var(--accent-deep)]">Repository pipeline</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">Your code is moving through the index.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">
              This page updates automatically. AI chat remains locked until every stage completes successfully.
            </p>
            <div className="mt-8">
              {statusQuery.isPending ? (
                <div className="h-80 animate-pulse rounded-[28px] border border-[var(--line)] bg-white" />
              ) : statusQuery.isError ? (
                <section role="alert" className="rounded-[28px] border border-rose-200 bg-white p-7 shadow-[0_22px_70px_rgba(14,27,24,0.08)]">
                  <CircleAlert aria-hidden="true" className="size-5 text-rose-700" />
                  <h2 className="mt-4 text-lg font-semibold">Repository status unavailable</h2>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    {apiErrorMessage(statusQuery.error, "The repository status could not be loaded.")}
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button type="button" onClick={() => statusQuery.refetch()} className="h-10 rounded-xl bg-[var(--ink)] px-4 text-xs font-semibold text-[var(--accent)]">Try again</button>
                    <button type="button" onClick={importAnother} className="h-10 rounded-xl border border-[var(--line)] bg-white px-4 text-xs font-semibold">Import another</button>
                  </div>
                </section>
              ) : (
                <RepositoryStatusCard
                  status={statusQuery.data}
                  retrying={retryMutation.isPending}
                  onRetry={() => retryMutation.mutate(activeRepositoryId)}
                  onImportAnother={importAnother}
                />
              )}
              {retryMutation.isError ? (
                <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  {apiErrorMessage(retryMutation.error, "Indexing could not be retried.")}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="grid gap-10 lg:grid-cols-[minmax(0,0.78fr)_minmax(420px,1.22fr)] lg:items-start">
            <section className="pt-3">
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.17em] text-[var(--accent-deep)]">Step 1 of 2</p>
              <h1 className="mt-4 text-4xl font-semibold leading-[1.02] tracking-[-0.052em] sm:text-5xl">Bring in a repository.</h1>
              <p className="mt-5 max-w-lg text-sm leading-7 text-[var(--muted)]">
                Import a public GitHub repository. The backend clones it safely, filters generated files and secrets, then creates a searchable semantic index.
              </p>
              <div className="mt-8 space-y-4">
                <div className="flex gap-3">
                  <GitPullRequestArrow aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--accent-deep)]" />
                  <div><p className="text-sm font-semibold">Branch aware</p><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Leave branch blank to use the repository default.</p></div>
                </div>
                <div className="flex gap-3">
                  <ServerCog aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--accent-deep)]" />
                  <div><p className="text-sm font-semibold">Worker processed</p><p className="mt-1 text-xs leading-5 text-[var(--muted)]">Keep the API, worker, database, Redis, and Qdrant running while indexing.</p></div>
                </div>
              </div>
            </section>

            <section className="rounded-[28px] border border-[var(--line)] bg-white p-6 shadow-[0_22px_70px_rgba(14,27,24,0.08)] sm:p-8">
              <div className="flex items-center gap-3 border-b border-[var(--line)] pb-5">
                <span className="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)]"><GitFork aria-hidden="true" className="size-4" /></span>
                <div><h2 className="text-sm font-semibold">Public GitHub repository</h2><p className="mt-0.5 text-xs text-[var(--muted)]">Private repository picker comes through the connected GitHub App.</p></div>
              </div>
              <form className="mt-6" onSubmit={handleImport} noValidate>
                <label htmlFor="repository-url" className="text-xs font-semibold">Repository URL</label>
                <input
                  id="repository-url"
                  type="url"
                  value={repositoryUrl}
                  onChange={(event) => { setRepositoryUrl(event.target.value); setFormError(undefined); importMutation.reset(); }}
                  placeholder="https://github.com/owner/repository"
                  autoComplete="url"
                  aria-invalid={Boolean(formError)}
                  className="mt-2 h-12 w-full rounded-xl border border-[var(--line-strong)] bg-[var(--surface-soft)]/55 px-4 text-sm outline-none transition placeholder:text-[var(--muted-strong)] focus:border-[#9dac93] focus:bg-white focus:ring-4 focus:ring-[#afc497]/15"
                />
                <label htmlFor="repository-branch" className="mt-5 block text-xs font-semibold">Branch <span className="font-normal text-[var(--muted-strong)]">(optional)</span></label>
                <input
                  id="repository-branch"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="Default branch"
                  autoComplete="off"
                  className="mt-2 h-12 w-full rounded-xl border border-[var(--line-strong)] bg-[var(--surface-soft)]/55 px-4 font-mono text-sm outline-none transition placeholder:font-sans placeholder:text-[var(--muted-strong)] focus:border-[#9dac93] focus:bg-white focus:ring-4 focus:ring-[#afc497]/15"
                />
                {formError || importMutation.isError ? (
                  <p role="alert" className="mt-3 text-xs leading-5 text-rose-700">
                    {formError ?? apiErrorMessage(importMutation.error, "The repository could not be imported.")}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={importMutation.isPending || !repositoryUrl.trim()}
                  className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-bold text-[var(--ink)] transition hover:bg-[var(--accent-bright)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {importMutation.isPending ? "Starting import…" : "Import and start indexing"}
                  {!importMutation.isPending ? <ArrowRight aria-hidden="true" className="size-4" /> : null}
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
