import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RepositoryChat } from "@/components/chat/repository-chat";
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

  return <RepositoryChat repositoryId={repositoryId} />;
}
