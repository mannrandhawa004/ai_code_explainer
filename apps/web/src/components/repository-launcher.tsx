"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Database, GitFork, LockKeyhole } from "lucide-react";
import Link from "next/link";

import { getCurrentUserOrNull } from "@/lib/api/auth";

export function RepositoryLauncher() {
  const userQuery = useQuery({
    queryKey: ["current-user"],
    queryFn: getCurrentUserOrNull,
    retry: false,
  });
  const isSignedIn = Boolean(userQuery.data);

  return (
    <aside className="relative overflow-hidden rounded-[28px] border border-white/10 bg-[var(--ink)] p-6 text-white shadow-[0_28px_100px_rgba(14,27,24,0.23)] sm:p-8">
      <div
        aria-hidden="true"
        className="absolute -right-16 -top-24 size-64 rounded-full bg-[var(--accent)]/15 blur-3xl"
      />
      <div className="relative">
        <span className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-white/10 text-[var(--accent)]">
          <Database aria-hidden="true" className="size-5" />
        </span>
        <p className="mt-9 font-mono text-[11px] font-semibold uppercase tracking-[0.17em] text-[var(--accent)]">
          Open a workspace
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
          Import. Index. Then ask.
        </h2>
        <p className="mt-3 text-sm leading-6 text-white/62">
          Sign in through the app, paste a GitHub repository URL, and follow
          indexing progress from one screen. Chat unlocks only when the code is
          ready.
        </p>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.055] p-4">
          <div className="flex items-start gap-3">
            <LockKeyhole
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
            />
            <div>
              <p className="text-xs font-semibold text-white/88">
                GitHub-backed account
              </p>
              <p className="mt-1 text-xs leading-5 text-white/45">
                The same button securely creates a first-time account or signs
                a returning user back in.
              </p>
            </div>
          </div>
        </div>

        {userQuery.isPending ? (
          <div className="mt-6 h-12 animate-pulse rounded-xl bg-white/10" />
        ) : (
          <Link
            href={isSignedIn ? "/repositories" : "/auth"}
            className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-bold text-[var(--ink)] transition hover:bg-[var(--accent-bright)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:translate-y-px"
          >
            {isSignedIn ? (
              <>
                Continue as @{userQuery.data?.username}
                <ArrowRight aria-hidden="true" className="size-4" />
              </>
            ) : (
              <>
                <GitFork aria-hidden="true" className="size-4" />
                {userQuery.isSuccess ? "Sign in with GitHub" : "Open sign in"}
              </>
            )}
          </Link>
        )}
      </div>
    </aside>
  );
}
