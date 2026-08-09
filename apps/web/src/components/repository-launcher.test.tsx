import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCurrentUserOrNull } from "@/lib/api/auth";

import { RepositoryLauncher } from "./repository-launcher";

vi.mock("@/lib/api/auth", () => ({ getCurrentUserOrNull: vi.fn() }));

function renderLauncher() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<RepositoryLauncher />, { wrapper: Wrapper });
}

beforeEach(() => vi.mocked(getCurrentUserOrNull).mockReset());

describe("RepositoryLauncher", () => {
  it("sends signed-out visitors to the in-app sign-in screen", async () => {
    vi.mocked(getCurrentUserOrNull).mockResolvedValue(null);
    renderLauncher();

    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(link).toHaveAttribute("href", "/auth");
    expect(screen.queryByLabelText("Repository ID")).not.toBeInTheDocument();
  });

  it("sends a returning user directly to the repository workspace", async () => {
    vi.mocked(getCurrentUserOrNull).mockResolvedValue({
      id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      githubId: "123",
      username: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    renderLauncher();

    const link = await screen.findByRole("link", { name: /Continue as @octocat/u });
    expect(link).toHaveAttribute("href", "/repositories");
  });
});
