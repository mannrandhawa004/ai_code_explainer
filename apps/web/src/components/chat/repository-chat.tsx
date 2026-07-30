"use client";

import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUp,
  Braces,
  CircleAlert,
  FileCode2,
  GitBranch,
  Hash,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { AnswerMarkdown } from "@/components/chat/answer-markdown";
import { AnswerProgress } from "@/components/chat/answer-progress";
import { SourceCard } from "@/components/chat/source-card";
import {
  askRepositoryQuestion,
  maximumQuestionCharacters,
  repositoryChatErrorMessage,
  type RepositoryAnswerSource,
  type RepositoryQuestionResult,
} from "@/lib/api/repository-chat";
import { abbreviate, cn } from "@/lib/utils";

type UserMessage = {
  id: string;
  role: "user";
  content: string;
};

type AssistantMessage = {
  id: string;
  role: "assistant";
  content: string;
  sources: RepositoryAnswerSource[];
  metadata: Pick<
    RepositoryQuestionResult,
    "branch" | "commitSha" | "retrievedChunks" | "latencyMs" | "model"
  >;
};

type ChatMessage = UserMessage | AssistantMessage;

const starterQuestions = [
  "Explain the main request flow in execution order.",
  "Where is authentication enforced?",
  "Which modules access the database?",
  "Summarize the repository architecture.",
];

let localMessageSequence = 0;

function localMessageId(prefix: string): string {
  localMessageSequence += 1;
  return `${prefix}-${Date.now()}-${localMessageSequence}`;
}

export function RepositoryChat({ repositoryId }: { repositoryId: string }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [lastFailedQuestion, setLastFailedQuestion] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const abortController = useRef<AbortController | undefined>(undefined);
  const messageEnd = useRef<HTMLDivElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  const mutation = useMutation({ mutationFn: askRepositoryQuestion });
  const latestAnswer = [...messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant");

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, mutation.isPending]);

  useEffect(
    () => () => {
      abortController.current?.abort();
      abortController.current = undefined;
    },
    [],
  );

  function submitQuestion(question: string, appendUserMessage = true) {
    const normalized = question.trim();
    if (
      !normalized ||
      normalized.length > maximumQuestionCharacters ||
      mutation.isPending
    ) {
      return;
    }

    if (appendUserMessage) {
      const userMessage: UserMessage = {
        id: localMessageId("user"),
        role: "user",
        content: normalized,
      };
      setMessages((current) => [...current, userMessage]);
    }
    setDraft("");
    setRequestError(undefined);
    setLastFailedQuestion(undefined);
    mutation.reset();

    const controller = new AbortController();
    abortController.current = controller;
    mutation.mutate(
      {
        repositoryId,
        question: normalized,
        ...(conversationId === undefined ? {} : { conversationId }),
        signal: controller.signal,
      },
      {
        onSuccess(result) {
          if (abortController.current !== controller) return;
          setConversationId(result.conversationId);
          setMessages((current) => [
            ...current,
            {
              id: result.assistantMessageId,
              role: "assistant",
              content: result.answer,
              sources: result.sources,
              metadata: {
                branch: result.branch,
                commitSha: result.commitSha,
                retrievedChunks: result.retrievedChunks,
                latencyMs: result.latencyMs,
                ...(result.model === undefined ? {} : { model: result.model }),
              },
            },
          ]);
          abortController.current = undefined;
          window.setTimeout(() => textArea.current?.focus(), 0);
        },
        onError(error) {
          if (abortController.current !== controller) return;
          abortController.current = undefined;
          if (error instanceof DOMException && error.name === "AbortError") {
            setRequestError("The question was cancelled before it completed.");
          } else {
            setRequestError(repositoryChatErrorMessage(error));
          }
          setLastFailedQuestion(normalized);
        },
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitQuestion(draft);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitQuestion(draft);
    }
  }

  function cancelRequest() {
    abortController.current?.abort();
  }

  function startNewConversation() {
    const activeController = abortController.current;
    abortController.current = undefined;
    activeController?.abort();
    setMessages([]);
    setConversationId(undefined);
    setRequestError(undefined);
    setLastFailedQuestion(undefined);
    setDraft("");
    mutation.reset();
    window.setTimeout(() => textArea.current?.focus(), 0);
  }

  const questionIsTooLong = draft.length > maximumQuestionCharacters;

  return (
    <main className="flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-[var(--canvas)]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              aria-label="Choose another repository"
              className="grid size-9 shrink-0 place-items-center rounded-xl border border-[var(--line)] bg-white text-[var(--muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
            </Link>
            <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-[var(--ink)] text-[var(--accent)] sm:grid">
              <Braces aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold tracking-[-0.02em]">
                  Repository chat
                </h1>
                <span className="hidden rounded-full bg-[var(--accent)]/50 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--accent-deep)] sm:inline-flex">
                  grounded
                </span>
              </div>
              <p className="truncate font-mono text-[10px] text-[var(--muted)]">
                {abbreviate(repositoryId, 6)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={startNewConversation}
            disabled={messages.length === 0 && !mutation.isPending}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-3 text-xs font-semibold text-[var(--muted)] transition hover:border-[var(--line-strong)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            <span>New conversation</span>
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1500px] flex-1 lg:grid-cols-[minmax(0,1fr)_310px]">
        <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col border-[var(--line)] lg:border-r">
          <div className="flex-1 px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
            <div className="mx-auto w-full max-w-3xl">
              {messages.length === 0 ? (
                <section className="pt-[6vh] sm:pt-[10vh]">
                  <span className="grid size-12 place-items-center rounded-2xl border border-[var(--line)] bg-white text-[var(--accent-deep)] shadow-sm">
                    <MessageSquareText aria-hidden="true" className="size-5" />
                  </span>
                  <h2 className="mt-6 max-w-xl text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
                    What do you want to understand?
                  </h2>
                  <p className="mt-3 max-w-xl text-sm leading-6 text-[var(--muted)] sm:text-base">
                    Ask about flows, symbols, configuration, dependencies, or
                    architecture. Answers use only the indexed repository context.
                  </p>
                  <div className="mt-8 grid gap-2 sm:grid-cols-2">
                    {starterQuestions.map((question) => (
                      <button
                        key={question}
                        type="button"
                        onClick={() => submitQuestion(question)}
                        className="group flex min-h-16 items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/70 px-4 py-3 text-left text-sm font-medium leading-5 transition hover:border-[var(--line-strong)] hover:bg-white hover:shadow-[0_10px_28px_rgba(14,27,24,0.06)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
                      >
                        <span>{question}</span>
                        <ArrowUp
                          aria-hidden="true"
                          className="size-4 shrink-0 rotate-45 text-[var(--muted-strong)] transition group-hover:text-[var(--accent-deep)]"
                        />
                      </button>
                    ))}
                  </div>
                </section>
              ) : (
                <div className="space-y-8" aria-live="polite">
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <article
                        key={message.id}
                        className="message-enter ml-auto max-w-[88%] rounded-2xl rounded-br-md bg-[var(--ink)] px-4 py-3 text-sm leading-6 text-white shadow-[0_12px_30px_rgba(14,27,24,0.14)] sm:max-w-[76%]"
                      >
                        {message.content}
                      </article>
                    ) : (
                      <article key={message.id} className="message-enter">
                        <div className="mb-3 flex items-center gap-2">
                          <span className="grid size-7 place-items-center rounded-lg bg-[var(--accent)] text-[var(--ink)]">
                            <Braces aria-hidden="true" className="size-3.5" />
                          </span>
                          <span className="text-xs font-semibold">Codebase Explainer</span>
                        </div>
                        <div className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_12px_36px_rgba(14,27,24,0.055)] sm:p-6">
                          <AnswerMarkdown content={message.content} />
                          {message.sources.length > 0 ? (
                            <div className="mt-6 border-t border-[var(--line)] pt-5">
                              <div className="mb-3 flex items-center justify-between gap-4">
                                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                                  <FileCode2 aria-hidden="true" className="size-3.5" />
                                  Sources
                                </h3>
                                <span className="font-mono text-[10px] text-[var(--muted-strong)]">
                                  {message.sources.length} cited
                                </span>
                              </div>
                              <div className="grid gap-2 sm:grid-cols-2">
                                {message.sources.map((source, index) => (
                                  <SourceCard
                                    key={`${source.filePath}:${source.startLine}:${source.endLine}:${index}`}
                                    source={source}
                                    index={index}
                                  />
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </article>
                    ),
                  )}
                </div>
              )}

              {mutation.isPending ? (
                <div className="mt-8">
                  <AnswerProgress />
                </div>
              ) : null}

              {requestError ? (
                <div
                  role="alert"
                  className="message-enter mt-6 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-950"
                >
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Answer unavailable</p>
                    <p className="mt-1 text-xs leading-5 text-rose-800">
                      {requestError}
                    </p>
                  </div>
                  {lastFailedQuestion ? (
                    <button
                      type="button"
                      onClick={() => submitQuestion(lastFailedQuestion, false)}
                      className="shrink-0 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold transition hover:border-rose-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
                    >
                      Retry
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRequestError(undefined)}
                      aria-label="Dismiss error"
                      className="grid size-7 shrink-0 place-items-center rounded-lg hover:bg-rose-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700"
                    >
                      <X aria-hidden="true" className="size-3.5" />
                    </button>
                  )}
                </div>
              ) : null}
              <div ref={messageEnd} />
            </div>
          </div>

          <div className="sticky bottom-0 z-10 border-t border-[var(--line)] bg-[var(--canvas)]/94 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-10">
            <form
              onSubmit={handleSubmit}
              className="mx-auto w-full max-w-3xl rounded-2xl border border-[var(--line-strong)] bg-white p-2 shadow-[0_18px_50px_rgba(14,27,24,0.1)] transition focus-within:border-[#9dac93] focus-within:ring-4 focus-within:ring-[#afc497]/15"
            >
              <label htmlFor="repository-question" className="sr-only">
                Ask a question about this repository
              </label>
              <textarea
                ref={textArea}
                id="repository-question"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                rows={2}
                maxLength={maximumQuestionCharacters + 1}
                placeholder="Ask about a flow, symbol, file, or architectural decision…"
                disabled={mutation.isPending}
                aria-invalid={questionIsTooLong}
                aria-describedby="composer-help"
                className="max-h-44 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 outline-none placeholder:text-[var(--muted-strong)] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-3 px-2 pb-1">
                <p
                  id="composer-help"
                  className={cn(
                    "text-[10px] text-[var(--muted-strong)]",
                    questionIsTooLong && "font-semibold text-[var(--danger)]",
                  )}
                >
                  {questionIsTooLong
                    ? `Question exceeds ${maximumQuestionCharacters.toLocaleString()} characters.`
                    : draft.length > 3_200
                      ? `${draft.length.toLocaleString()} / ${maximumQuestionCharacters.toLocaleString()}`
                      : "Enter to send · Shift + Enter for a new line"}
                </p>
                {mutation.isPending ? (
                  <button
                    type="button"
                    onClick={cancelRequest}
                    className="inline-flex size-9 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] text-[var(--muted)] transition hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-deep)]"
                    aria-label="Cancel question"
                  >
                    <Square aria-hidden="true" className="size-3" fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!draft.trim() || questionIsTooLong}
                    className="inline-flex size-9 items-center justify-center rounded-xl bg-[var(--ink)] text-[var(--accent)] transition hover:bg-[var(--ink-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)] disabled:cursor-not-allowed disabled:bg-[#dfe4dc] disabled:text-[#929b95]"
                    aria-label="Send question"
                  >
                    <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.4} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>

        <aside className="hidden bg-[#eef1eb]/65 px-6 py-8 lg:block">
          <div className="sticky top-24 space-y-6">
            <section>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted-strong)]">
                Repository scope
              </p>
              <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white/75 p-4">
                <p className="break-all font-mono text-[11px] leading-5 text-[var(--muted)]">
                  {repositoryId}
                </p>
                {latestAnswer ? (
                  <div className="mt-4 space-y-2 border-t border-[var(--line)] pt-4">
                    <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                      <GitBranch aria-hidden="true" className="size-3.5" />
                      <span className="truncate">{latestAnswer.metadata.branch}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                      <Hash aria-hidden="true" className="size-3.5" />
                      <span className="font-mono">
                        {abbreviate(latestAnswer.metadata.commitSha, 7)}
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {latestAnswer ? (
              <section>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--muted-strong)]">
                  Last answer
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-[var(--line)] bg-white/75 p-3">
                    <p className="text-lg font-semibold tracking-[-0.04em]">
                      {latestAnswer.metadata.retrievedChunks}
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                      chunks retrieved
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--line)] bg-white/75 p-3">
                    <p className="text-lg font-semibold tracking-[-0.04em]">
                      {(latestAnswer.metadata.latencyMs / 1_000).toFixed(1)}s
                    </p>
                    <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                      response time
                    </p>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="rounded-2xl border border-[#cfe0aa] bg-[#eef7d9] p-4">
              <ShieldCheck
                aria-hidden="true"
                className="size-5 text-[var(--accent-deep)]"
              />
              <h2 className="mt-4 text-sm font-semibold">Evidence stays attached</h2>
              <p className="mt-1.5 text-xs leading-5 text-[#5c694c]">
                Citation paths and line ranges are generated from validated
                retrieval metadata, not model-written references.
              </p>
            </section>
          </div>
        </aside>
      </div>
    </main>
  );
}
