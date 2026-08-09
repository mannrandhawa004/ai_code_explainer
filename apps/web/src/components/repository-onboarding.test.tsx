import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentUserOrNull, logout } from "@/lib/api/auth";
import {
  getRepositoryStatus,
  importRepository,
  retryRepositoryIndexing,
} from "@/lib/api/repositories";

import { RepositoryOnboarding } from "./repository-onboarding";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api/auth", () => ({
  getCurrentUserOrNull: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("@/lib/api/repositories", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/repositories")>();
  return {
    ...original,
    getRepositoryStatus: vi.fn(),
    importRepository: vi.fn(),
    retryRepositoryIndexing: vi.fn(),
  };
});

function renderOnboarding() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RepositoryOnboarding />, { wrapper: Wrapper });
}

beforeEach(() => {
  window.localStorage.clear();
  push.mockReset();
  vi.mocked(getCurrentUserOrNull).mockReset();
  vi.mocked(logout).mockReset();
  vi.mocked(importRepository).mockReset();
  vi.mocked(getRepositoryStatus).mockReset();
  vi.mocked(retryRepositoryIndexing).mockReset();
});

describe("RepositoryOnboarding", () => {
  it("keeps repository import behind the in-app sign-in state", async () => {
    vi.mocked(getCurrentUserOrNull).mockResolvedValue(null);
    renderOnboarding();

    expect(
      await screen.findByRole("heading", { name: "Sign in to import a repository" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "http://localhost:5000/api/auth/github",
    );
  });

  it("imports from the UI and shows indexing progress without exposing chat", async () => {
    const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    vi.mocked(getCurrentUserOrNull).mockResolvedValue({
      id: "bbbbbbbbbbbbbbbbbbbbbbbb",
      githubId: "123",
      username: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    vi.mocked(importRepository).mockResolvedValue({
      repositoryId,
      jobId: "job-1",
      status: "queued",
      deduplicated: false,
    });
    vi.mocked(getRepositoryStatus).mockResolvedValue({
      repositoryId,
      status: "queued",
      selectedBranch: "main",
      stats: { files: 0, chunks: 0 },
      job: { id: "job-1", status: "waiting", progress: 0, currentStep: "queued" },
    });
    const user = userEvent.setup();
    renderOnboarding();

    await user.type(
      await screen.findByLabelText("Repository URL"),
      "https://github.com/openai/openai-node",
    );
    await user.click(screen.getByRole("button", { name: "Import and start indexing" }));

    expect(vi.mocked(importRepository).mock.calls[0]?.[0]).toEqual({
      repositoryUrl: "https://github.com/openai/openai-node",
    });
    expect(await screen.findByText("Waiting for the indexing worker")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open AI chat" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("codebase-explainer.active-repository")).toBe(
      repositoryId,
    );
  });
});
