import { Braces, FileSearch2, GitBranch, ShieldCheck } from "lucide-react";

import { RepositoryLauncher } from "@/components/repository-launcher";

const capabilities = [
  {
    icon: FileSearch2,
    title: "Evidence first",
    body: "Every generated explanation links back to retrieved files and exact line ranges.",
  },
  {
    icon: GitBranch,
    title: "Commit aware",
    body: "Questions stay scoped to the repository branch and commit that was indexed.",
  },
  {
    icon: ShieldCheck,
    title: "Grounded by design",
    body: "Unknown or model-invented source references are rejected by the API.",
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[var(--canvas)] text-[var(--ink)]">
      <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 sm:px-8 lg:px-10">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)] shadow-[0_8px_28px_rgba(14,27,24,0.18)]">
            <Braces aria-hidden="true" className="size-5" strokeWidth={2.4} />
          </span>
          <div>
            <p className="text-sm font-semibold tracking-[-0.02em]">
              Codebase Explainer
            </p>
            <p className="text-xs text-[var(--muted)]">Repository intelligence</p>
          </div>
        </div>
        <span className="rounded-full border border-[var(--line)] bg-white/70 px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
          Cited answers
        </span>
      </header>

      <section className="mx-auto grid w-full max-w-7xl gap-10 px-5 pb-14 pt-10 sm:px-8 md:pt-20 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,0.72fr)] lg:items-center lg:gap-20 lg:px-10 lg:pb-24">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/70 px-3 py-1.5 text-xs font-medium text-[var(--muted)] shadow-sm backdrop-blur">
            <span className="size-1.5 rounded-full bg-[var(--accent-strong)]" />
            Answers grounded in your indexed code
          </div>
          <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl lg:text-7xl">
            Understand the code.
            <span className="mt-2 block text-[var(--muted-strong)]">
              Keep the receipts.
            </span>
          </h1>
          <p className="mt-7 max-w-xl text-pretty text-base leading-7 text-[var(--muted)] sm:text-lg sm:leading-8">
            Ask how a request flows, where a symbol is used, or why a service
            behaves the way it does. Each important claim arrives with the file
            and lines that support it.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            {capabilities.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="rounded-2xl border border-[var(--line)] bg-white/55 p-4 backdrop-blur-sm"
              >
                <Icon
                  aria-hidden="true"
                  className="mb-5 size-5 text-[var(--accent-deep)]"
                />
                <h2 className="text-sm font-semibold tracking-[-0.02em]">
                  {title}
                </h2>
                <p className="mt-1.5 text-xs leading-5 text-[var(--muted)]">
                  {body}
                </p>
              </article>
            ))}
          </div>
        </div>

        <RepositoryLauncher />
      </section>
    </main>
  );
}
