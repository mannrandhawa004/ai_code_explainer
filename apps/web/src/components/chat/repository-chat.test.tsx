import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RepositoryChatApiError,
  askRepositoryQuestion,
  type RepositoryQuestionResult,
} from "@/lib/api/repository-chat";

import { RepositoryChat } from "./repository-chat";

vi.mock("@/lib/api/repository-chat", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/lib/api/repository-chat")
  >();
  return { ...original, askRepositoryQuestion: vi.fn() };
});

const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const answerResult: RepositoryQuestionResult = {
  repositoryId,
  conversationId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  userMessageId: "cccccccccccccccccccccccc",
  assistantMessageId: "dddddddddddddddddddddddd",
  answer: "Authentication uses **middleware**. [src/auth.ts:L1-L3]",
  sources: [
    {
      filePath: "src/auth.ts",
      startLine: 1,
      endLine: 3,
      symbolName: "authenticate",
    },
  ],
  category: "semantic",
  branch: "main",
  commitSha: "abc123",
  retrievedChunks: 3,
  embeddingModel: "text-embedding-3-small",
  model: "gpt-5.6-sol",
  providerResponseId: "response-1",
  usage: {
    inputTokens: 100,
    outputTokens: 25,
    reasoningTokens: 10,
    totalTokens: 125,
  },
  latencyMs: 250,
};

function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RepositoryChat repositoryId={repositoryId} />, {
    wrapper: Wrapper,
  });
}

beforeEach(() => {
  vi.mocked(askRepositoryQuestion).mockReset();
});

describe("RepositoryChat", () => {
  it("submits a question and renders Markdown with validated source cards", async () => {
    vi.mocked(askRepositoryQuestion).mockResolvedValue(answerResult);
    const user = userEvent.setup();
    renderChat();

    const composer = screen.getByLabelText("Ask a question about this repository");
    await user.type(composer, "How does authentication work?");
    await user.click(screen.getByRole("button", { name: "Send question" }));

    expect(await screen.findByText("middleware")).toBeInTheDocument();
    expect(screen.getByText("src/auth.ts")).toBeInTheDocument();
    expect(screen.getByText("L1–L3")).toBeInTheDocument();
    expect(vi.mocked(askRepositoryQuestion).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        repositoryId,
        question: "How does authentication work?",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("continues the persisted conversation after the first answer", async () => {
    vi.mocked(askRepositoryQuestion)
      .mockResolvedValueOnce(answerResult)
      .mockResolvedValueOnce({
        ...answerResult,
        userMessageId: "eeeeeeeeeeeeeeeeeeeeeeee",
        assistantMessageId: "ffffffffffffffffffffffff",
      });
    const user = userEvent.setup();
    renderChat();
    const composer = screen.getByLabelText("Ask a question about this repository");

    await user.type(composer, "First question");
    await user.keyboard("{Enter}");
    await screen.findByText("middleware");
    await user.type(composer, "Follow-up question");
    await user.keyboard("{Enter}");

    expect(vi.mocked(askRepositoryQuestion).mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        question: "Follow-up question",
        conversationId: answerResult.conversationId,
      }),
    );
  });

  it("shows an actionable authentication error and retries without duplicating the question", async () => {
    vi.mocked(askRepositoryQuestion)
      .mockRejectedValueOnce(
        new RepositoryChatApiError(
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
        ),
      )
      .mockResolvedValueOnce(answerResult);
    const user = userEvent.setup();
    renderChat();

    const composer = screen.getByLabelText("Ask a question about this repository");
    await user.type(composer, "Explain authentication");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in");
    expect(screen.getAllByText("Explain authentication")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("middleware")).toBeInTheDocument();
    expect(screen.getAllByText("Explain authentication")).toHaveLength(1);
  });

  it("starts from a guide question and can clear the conversation", async () => {
    vi.mocked(askRepositoryQuestion).mockResolvedValue(answerResult);
    const user = userEvent.setup();
    renderChat();

    await user.click(
      screen.getByRole("button", {
        name: "Where is authentication enforced?",
      }),
    );
    await screen.findByText("middleware");
    await user.click(screen.getByRole("button", { name: "New conversation" }));

    expect(
      screen.getByText("What do you want to understand?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("src/auth.ts")).not.toBeInTheDocument();
  });
});
