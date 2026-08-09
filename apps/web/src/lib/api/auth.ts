import { ApiError, apiRequest } from "./client";

export type AuthenticatedUser = {
  id: string;
  githubId: string;
  username: string;
  avatarUrl: string;
  email?: string;
};

export function getCurrentUser(): Promise<AuthenticatedUser> {
  return apiRequest<AuthenticatedUser>("/api/auth/me");
}

export async function getCurrentUserOrNull(): Promise<AuthenticatedUser | null> {
  try {
    return await getCurrentUser();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export function logout(): Promise<void> {
  return apiRequest<void>("/api/auth/logout", { method: "POST" });
}
