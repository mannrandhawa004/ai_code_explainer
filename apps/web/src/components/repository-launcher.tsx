"use client";

import { ArrowRight, Database, LockKeyhole } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { repositoryIdPattern } from "@/lib/api/repository-chat";

export function RepositoryLauncher() {
  const router = useRouter();
  const [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = repositoryId.trim();
    if (!repositoryIdPattern.test(normalized)) {
      setError("Enter the 24-character ID of an indexed repository.");
      return;
    }
    setError("");
    router.push(`/repositories/${normalized}/chat`);
  }

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
          Start with an indexed repository.
        </h2>
        <p className="mt-3 text-sm leading-6 text-white/62">
          Paste the repository ID returned by the import flow. Access is checked
          by the API before any model request is made.
        </p>

        <form className="mt-8" onSubmit={handleSubmit} noValidate>
          <label
            htmlFor="repository-id"
            className="mb-2 block text-xs font-medium text-white/72"
          >
            Repository ID
          </label>
          <input
            id="repository-id"
            value={repositoryId}
            onChange={(event) => {
              setRepositoryId(event.target.value);
              if (error) setError("");
            }}
            placeholder="64f0c8a41d1b2c3d4e5f6789"
            spellCheck={false}
            autoComplete="off"
            aria-describedby={error ? "repository-id-error" : "repository-id-help"}
            aria-invalid={Boolean(error)}
            className="h-12 w-full rounded-xl border border-white/12 bg-white/[0.07] px-4 font-mono text-sm text-white outline-none transition placeholder:text-white/24 focus:border-[var(--accent)]/65 focus:bg-white/10 focus:ring-4 focus:ring-[var(--accent)]/10"
          />
          <div className="mt-2 min-h-5 text-xs">
            {error ? (
              <p id="repository-id-error" role="alert" className="text-rose-300">
                {error}
              </p>
            ) : (
              <p id="repository-id-help" className="flex items-center gap-1.5 text-white/38">
                <LockKeyhole aria-hidden="true" className="size-3" />
                Ownership is verified using your session.
              </p>
            )}
          </div>
          <button
            type="submit"
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-5 text-sm font-bold text-[var(--ink)] transition hover:bg-[var(--accent-bright)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:translate-y-px"
          >
            Open repository chat
            <ArrowRight aria-hidden="true" className="size-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
