import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getRepositoryStatus,
  retryRepositoryIndexing,
  type RepositoryIndexingStatus,
} from "@/lib/api/repositories";

import { RepositoryChatGate } from "./repository-chat-gate";

vi.mock("@/lib/api/repositories", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/repositories")>();
  return {
    ...original,
    getRepositoryStatus: vi.fn(),
    retryRepositoryIndexing: vi.fn(),
  };
});

vi.mock("./repository-chat", () => ({
  RepositoryChat: () => <div>Unlocked repository composer</div>,
}));

const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const embeddingStatus: RepositoryIndexingStatus = {
  repositoryId,
  status: "embedding",
  selectedBranch: "main",
  stats: { files: 12, chunks: 48 },
  job: {
    id: "job-1",
    status: "active",
    progress: 65,
    currentStep: "embedding",
  },
};

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RepositoryChatGate repositoryId={repositoryId} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  vi.mocked(getRepositoryStatus).mockReset();
  vi.mocked(retryRepositoryIndexing).mockReset();
});

describe("RepositoryChatGate", () => {
  it("does not mount chat while indexing is incomplete", async () => {
    vi.mocked(getRepositoryStatus).mockResolvedValue(embeddingStatus);
    renderGate();

    expect(await screen.findByText("AI chat is locked for now")).toBeInTheDocument();
    expect(screen.queryByText("Unlocked repository composer")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "65");
  });

  it("mounts chat only after the repository is ready", async () => {
    vi.mocked(getRepositoryStatus).mockResolvedValue({
      ...embeddingStatus,
      status: "ready",
      indexedAt: new Date().toISOString(),
      job: { ...embeddingStatus.job!, status: "completed", progress: 100 },
    });
    renderGate();

    expect(await screen.findByText("Unlocked repository composer")).toBeInTheDocument();
    expect(screen.queryByText("AI chat is locked for now")).not.toBeInTheDocument();
  });

  it("explains embedding failures and provides a retry", async () => {
    vi.mocked(getRepositoryStatus).mockResolvedValue({
      ...embeddingStatus,
      status: "failed",
      errorMessage: "A repository indexing dependency is unavailable",
      job: { ...embeddingStatus.job!, status: "failed" },
    });
    vi.mocked(retryRepositoryIndexing).mockResolvedValue({
      repositoryId,
      jobId: "job-2",
      status: "queued",
      deduplicated: false,
    });
    const user = userEvent.setup();
    renderGate();

    expect(await screen.findByText(/Check the server's AI provider key/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry indexing" }));
    expect(retryRepositoryIndexing).toHaveBeenCalledWith(repositoryId);
    expect(screen.queryByText("Unlocked repository composer")).not.toBeInTheDocument();
  });
});
