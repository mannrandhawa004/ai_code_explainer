import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { GitHubAuthServiceContract } from "../src/services/github-auth.service.js";

const userId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const state = "oauth-state-with-more-than-twenty-characters";

function createService(): GitHubAuthServiceContract {
  return {
    createAuthorizationRequest: vi.fn().mockReturnValue({
      state,
      url: `https://github.com/login/oauth/authorize?state=${state}`,
    }),
    completeAuthorization: vi.fn().mockResolvedValue({
      sessionToken: "signed-session-token",
      user: {
        id: userId,
        githubId: "12345",
        username: "developer",
        avatarUrl: "https://avatars.example/developer",
      },
    }),
    verifySession: vi.fn().mockReturnValue(userId),
    getCurrentUser: vi.fn().mockResolvedValue({
      id: userId,
      githubId: "12345",
      username: "developer",
      avatarUrl: "https://avatars.example/developer",
    }),
  };
}

function createTestApp(service: GitHubAuthServiceContract) {
  return createApp({
    logger: pino({ level: "silent" }),
    disableRateLimit: true,
    githubAuthService: service,
  });
}

describe("GitHub authentication routes", () => {
  it("sets an HttpOnly state cookie and redirects to GitHub", async () => {
    const response = await request(createTestApp(createService()))
      .get("/api/auth/github")
      .expect(302);

    expect(response.headers.location).toContain("github.com/login/oauth/authorize");
    expect(response.headers["set-cookie"]?.[0]).toContain(
      "codebase_explainer_oauth_state=",
    );
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
  });

  it("validates OAuth state before issuing the session cookie", async () => {
    const service = createService();
    const agent = request.agent(createTestApp(service));
    await agent.get("/api/auth/github").expect(302);

    const response = await agent
      .get("/api/auth/github/callback")
      .query({ code: "temporary-code", state })
      .expect(302);

    expect(service.completeAuthorization).toHaveBeenCalledWith("temporary-code");
    expect(response.headers.location).toBe("http://localhost:3000/repositories");
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("codebase_explainer_session=signed-session-token"),
      ]),
    );
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const service = createService();
    const agent = request.agent(createTestApp(service));
    await agent.get("/api/auth/github").expect(302);

    const response = await agent
      .get("/api/auth/github/callback")
      .query({ code: "temporary-code", state: "different-state-value-that-is-long-enough" })
      .expect(400);

    expect(response.body.error.code).toBe("INVALID_OAUTH_CALLBACK");
    expect(service.completeAuthorization).not.toHaveBeenCalled();
  });

  it("returns only sanitized current-user metadata", async () => {
    const service = createService();
    const response = await request(createTestApp(service))
      .get("/api/auth/me")
      .set("Cookie", "codebase_explainer_session=session")
      .expect(200);

    expect(response.body.data).toEqual({
      id: userId,
      githubId: "12345",
      username: "developer",
      avatarUrl: "https://avatars.example/developer",
    });
    expect(JSON.stringify(response.body)).not.toContain("token");
  });
});
