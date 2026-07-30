"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const languageAliases: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
};

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let active = true;
    const normalizedLanguage = languageAliases[language] ?? language ?? "text";

    void import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: normalizedLanguage,
          theme: "github-dark-default",
        }),
      )
      .then((highlighted) => {
        if (active) setHtml(highlighted);
      })
      .catch(() => {
        if (active) setHtml(undefined);
      });

    return () => {
      active = false;
    };
  }, [code, language]);

  if (!html) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className="shiki-frame"
      // Shiki escapes the source string before generating this highlighted HTML.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function SafeLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  if (!href || !/^https?:\/\//iu.test(href)) {
    return <span>{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
      {children}
    </a>
  );
}

const markdownComponents: Components = {
  a: SafeLink,
  code({ className, children, ...props }) {
    const language = /language-([\w+-]+)/u.exec(className ?? "")?.[1];
    const code = String(children).replace(/\n$/u, "");
    if (language) {
      return <HighlightedCode code={code} language={language} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export function AnswerMarkdown({ content }: { content: string }) {
  return (
    <div className="answer-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
