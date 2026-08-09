import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RepositoryChatGate } from "@/components/chat/repository-chat-gate";
import { repositoryIdPattern } from "@/lib/api/repository-chat";

export const metadata: Metadata = { title: "Repository chat" };

export default async function RepositoryChatPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  if (!repositoryIdPattern.test(repositoryId)) {
    notFound();
  }

  return <RepositoryChatGate repositoryId={repositoryId} />;
}
