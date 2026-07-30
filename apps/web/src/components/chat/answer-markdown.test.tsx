import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnswerMarkdown } from "./answer-markdown";

describe("AnswerMarkdown", () => {
  it("supports GitHub-flavored Markdown without executing raw HTML", () => {
    const { container } = render(
      <AnswerMarkdown
        content={"- **Grounded** answer\n- Second item\n\n<script>alert('x')</script>"}
      />,
    );

    expect(screen.getByText("Grounded")).toBeInTheDocument();
    expect(screen.getByText("Second item")).toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
  });

  it("renders only HTTP links as clickable external links", () => {
    render(
      <AnswerMarkdown
        content={"[safe](https://example.com) [unsafe](javascript:alert(1))"}
      />,
    );

    expect(screen.getByRole("link", { name: "safe" })).toHaveAttribute(
      "rel",
      "noreferrer noopener",
    );
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
  });
});
