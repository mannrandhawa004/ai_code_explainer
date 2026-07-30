import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryLauncher } from "./repository-launcher";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

beforeEach(() => push.mockReset());

describe("RepositoryLauncher", () => {
  it("validates a repository ID before navigation", async () => {
    const user = userEvent.setup();
    render(<RepositoryLauncher />);

    await user.type(screen.getByLabelText("Repository ID"), "invalid");
    await user.click(screen.getByRole("button", { name: "Open repository chat" }));

    expect(screen.getByRole("alert")).toHaveTextContent("24-character");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens the chat route for a normalized repository ID", async () => {
    const user = userEvent.setup();
    render(<RepositoryLauncher />);
    const repositoryId = "aaaaaaaaaaaaaaaaaaaaaaaa";

    await user.type(screen.getByLabelText("Repository ID"), ` ${repositoryId} `);
    await user.click(screen.getByRole("button", { name: "Open repository chat" }));

    expect(push).toHaveBeenCalledWith(`/repositories/${repositoryId}/chat`);
  });
});
