import type { Metadata } from "next";

import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = { title: "Sign in" };

export default function AuthPage() {
  return <AuthPanel />;
}
