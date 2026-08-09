import type { Metadata } from "next";

import { RepositoryOnboarding } from "@/components/repository-onboarding";

export const metadata: Metadata = { title: "Repositories" };

export default function RepositoriesPage() {
  return <RepositoryOnboarding />;
}
