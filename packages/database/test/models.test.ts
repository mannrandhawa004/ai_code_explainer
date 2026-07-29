import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  MessageModel,
  RepositoryFileModel,
  RepositoryModel,
  SymbolModel,
  UserModel,
} from "../src/index.js";

describe("database models", () => {
  it("validates a GitHub user and normalizes the email", async () => {
    const user = new UserModel({
      githubId: "12345",
      username: "developer",
      avatarUrl: "https://avatars.example/developer",
      email: "Developer@Example.com",
    });

    await expect(user.validate()).resolves.toBeUndefined();
    expect(user.email).toBe("developer@example.com");
  });

  it("applies safe repository defaults", async () => {
    const repository = new RepositoryModel({
      userId: new Types.ObjectId(),
      githubRepositoryId: 101,
      owner: "owner",
      name: "repository",
      fullName: "owner/repository",
      private: false,
      selectedBranch: "main",
      defaultBranch: "main",
    });

    await expect(repository.validate()).resolves.toBeUndefined();
    expect(repository.status).toBe("pending");
    expect(repository.stats.files).toBe(0);
    expect(repository.stats.chunks).toBe(0);
  });

  it("rejects repository files with negative sizes", async () => {
    const file = new RepositoryFileModel({
      repositoryId: new Types.ObjectId(),
      branch: "main",
      commitSha: "abc123",
      path: "src/index.ts",
      language: "typescript",
      hash: "hash",
      size: -1,
    });

    await expect(file.validate()).rejects.toMatchObject({
      errors: { size: expect.anything() },
    });
  });

  it("rejects symbols with reversed line ranges", async () => {
    const symbol = new SymbolModel({
      repositoryId: new Types.ObjectId(),
      fileId: new Types.ObjectId(),
      name: "createUser",
      type: "function",
      startLine: 20,
      endLine: 10,
    });

    await expect(symbol.validate()).rejects.toMatchObject({
      errors: { endLine: expect.anything() },
    });
  });

  it("rejects unsupported message roles", async () => {
    const message = new MessageModel({
      conversationId: new Types.ObjectId(),
      role: "system",
      content: "Untrusted message",
    });

    await expect(message.validate()).rejects.toMatchObject({
      errors: { role: expect.anything() },
    });
  });

  it("validates non-negative answer token usage", async () => {
    const message = new MessageModel({
      conversationId: new Types.ObjectId(),
      role: "assistant",
      content: "Grounded answer",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 25,
        reasoningTokens: -1,
        totalTokens: 125,
      },
    });

    await expect(message.validate()).rejects.toMatchObject({
      errors: { "tokenUsage.reasoningTokens": expect.anything() },
    });
  });

  it("rejects message sources with reversed line ranges", async () => {
    const message = new MessageModel({
      conversationId: new Types.ObjectId(),
      role: "assistant",
      content: "Grounded answer",
      sources: [
        {
          filePath: "src/auth.ts",
          startLine: 20,
          endLine: 10,
        },
      ],
    });

    await expect(message.validate()).rejects.toMatchObject({
      errors: { "sources.0.endLine": expect.anything() },
    });
  });

  it("defines tenant-aware repository indexes", () => {
    const indexes = RepositoryModel.schema.indexes();
    expect(indexes).toContainEqual([
      { userId: 1, githubRepositoryId: 1 },
      { unique: true },
    ]);
  });
});
