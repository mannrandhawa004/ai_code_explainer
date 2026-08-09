"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Braces, Check, GitFork, LockKeyhole } from "lucide-react";
import Link from "next/link";

import { getCurrentUserOrNull } from "@/lib/api/auth";
import { githubSignInUrl } from "@/lib/api/client";

const assurances = [
  "No API URLs to copy or open manually",
  "Session stored in a secure HTTP-only cookie",
  "Repository ownership checked by the backend",
];

export function AuthPanel() {
  const userQuery = useQuery({
    queryKey: ["current-user"],
    queryFn: getCurrentUserOrNull,
    retry: false,
  });

  return (
    <main className="grid min-h-screen bg-[var(--canvas)] text-[var(--ink)] lg:grid-cols-[0.92fr_1.08fr]">
      <section className="flex flex-col justify-between bg-[var(--ink)] p-6 text-white sm:p-10 lg:min-h-screen lg:p-14">
        <Link
          href="/"
          className="flex w-fit items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
        >
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--accent)] text-[var(--ink)]">
            <Braces aria-hidden="true" className="size-5" />
          </span>
          <span className="text-sm font-semibold">Codebase Explainer</span>
        </Link>

        <div className="my-16 max-w-xl lg:my-0">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
            One secure entry point
          </p>
          <h1 className="mt-5 text-3xl font-semibold leading-[1.02] tracking-[-0.05em] sm:text-5xl">
            Your repositories,
            <span className="block text-white/45">ready to explain.</span>
          </h1>
          <p className="mt-6 max-w-lg text-sm leading-7 text-white/58 sm:text-base">
            GitHub verifies who you are. The app then guides you through import,
            indexing, and grounded AI chat without requiring manual API routes.
          </p>
        </div>

        <p className="text-xs text-white/35">
          Your GitHub password is never shared with this application.
        </p>
      </section>

      <section className="grid place-items-center px-5 py-14 sm:px-10">
        <div className="w-full max-w-md">
          <span className="grid size-12 place-items-center rounded-2xl border border-[var(--line)] bg-white text-[var(--accent-deep)] shadow-sm">
            <LockKeyhole aria-hidden="true" className="size-5" />
          </span>
          <h2 className="mt-7 text-2xl font-semibold tracking-[-0.045em] sm:text-3xl">
            {userQuery.data ? "You’re signed in" : "Continue with GitHub"}
          </h2>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
            {userQuery.data
              ? `Welcome back, @${userQuery.data.username}. Your workspace is ready.`
              : "New users get an account automatically. Returning users are signed into their existing account."}
          </p>

          {userQuery.isPending ? (
            <div className="mt-8 h-12 animate-pulse rounded-xl bg-[var(--line)]" />
          ) : userQuery.data ? (
            <Link
              href="/repositories"
              className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-5 text-sm font-bold text-[var(--accent)] transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            >
              Open repository workspace
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          ) : (
            <a
              href={githubSignInUrl()}
              className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-5 text-sm font-bold text-white transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
            >
              <GitFork aria-hidden="true" className="size-4" />
              Sign in with GitHub
            </a>
          )}

          <ul className="mt-8 space-y-3 border-t border-[var(--line)] pt-7">
            {assurances.map((assurance) => (
              <li
                key={assurance}
                className="flex items-center gap-3 text-xs text-[var(--muted)]"
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#e8f3d4] text-[var(--accent-deep)]">
                  <Check aria-hidden="true" className="size-3" />
                </span>
                {assurance}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
