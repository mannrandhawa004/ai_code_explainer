import Link from "next/link";
import { ArrowLeft, Braces } from "lucide-react";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas)] px-5 text-[var(--ink)]">
      <section className="w-full max-w-md rounded-3xl border border-[var(--line)] bg-white p-8 shadow-[0_24px_80px_rgba(14,27,24,0.09)]">
        <span className="grid size-11 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)]">
          <Braces aria-hidden="true" className="size-5" />
        </span>
        <p className="mt-8 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent-deep)]">
          Invalid repository
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">
          This chat route does not exist.
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          Repository chat URLs require a valid 24-character repository ID.
        </p>
        <Link
          href="/"
          className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Choose a repository
        </Link>
      </section>
    </main>
  );
}
