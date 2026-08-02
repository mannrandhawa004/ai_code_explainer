import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RepositoryFileFilter,
  RepositoryTreeSitterChunker,
  TreeSitterCodeChunker,
  type LineChunkSourceMetadata,
} from "../src/index.js";

const metadata: LineChunkSourceMetadata = {
  userId: "user-1",
  repositoryId: "repository-1",
  branch: "main",
  commitSha: "abc123",
  filePath: "src/features/users.tsx",
  language: "tsx",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("TreeSitterCodeChunker", () => {
  it("extracts TypeScript, React, class, method, import, export, and route metadata", () => {
    const source = [
      'import type { FC } from "react";',
      'import { Router } from "express";',
      "export interface UserRecord {",
      "  id: string;",
      "}",
      "export class UserService {",
      "  find(id: string) { return id; }",
      "}",
      "export const UserCard: FC<{ user: UserRecord }> = ({ user }) => <article>{user.id}</article>;",
      "const router = Router();",
      'router.get("/users/:id", getUser);',
      "export async function getUser() { return new UserService(); }",
    ].join("\n");

    const result = new TreeSitterCodeChunker().chunk(source, metadata);

    expect(result.chunkingStrategy).toBe("tree_sitter");
    expect(result.imports).toEqual(["react", "FC", "express", "Router"]);
    expect(result.exports).toEqual([
      "UserRecord",
      "UserService",
      "UserCard",
      "getUser",
    ]);
    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "UserRecord",
          type: "interface",
          startLine: 3,
          endLine: 5,
        }),
        expect.objectContaining({
          name: "UserService",
          type: "service",
          startLine: 6,
          endLine: 8,
        }),
        expect.objectContaining({
          name: "find",
          type: "method",
          startLine: 7,
          endLine: 7,
        }),
        expect.objectContaining({
          name: "UserCard",
          type: "react_component",
          startLine: 9,
          endLine: 9,
        }),
        expect.objectContaining({
          name: "GET /users/:id",
          type: "express_route",
          startLine: 11,
          endLine: 11,
        }),
        expect.objectContaining({
          name: "getUser",
          type: "function",
          startLine: 12,
          endLine: 12,
          references: expect.arrayContaining(["UserService"]),
        }),
      ]),
    );
    expect(result.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbolName: "UserCard",
          symbolType: "react_component",
          startLine: 9,
          endLine: 9,
          imports: ["react", "FC", "express", "Router"],
          exports: ["UserCard"],
        }),
      ]),
    );
    expect(result.chunks.map((chunk) => chunk.chunkIndex)).toEqual(
      result.chunks.map((_, index) => index),
    );
    expect(new TreeSitterCodeChunker().chunk(source, metadata)).toEqual(result);
  });

  it("classifies controller and model symbols from repository conventions", () => {
    const controller = new TreeSitterCodeChunker().chunk(
      "export async function getUser() { return UserModel.findById('1'); }",
      {
        ...metadata,
        filePath: "src/controllers/user.controller.ts",
        language: "typescript",
      },
    );
    const model = new TreeSitterCodeChunker().chunk(
      "export const UserSchema = new mongoose.Schema({ name: String });",
      {
        ...metadata,
        filePath: "src/models/user.model.ts",
        language: "typescript",
      },
    );

    expect(controller.symbols).toEqual([
      expect.objectContaining({ name: "getUser", type: "controller" }),
    ]);
    expect(model.symbols).toEqual([
      expect.objectContaining({ name: "UserSchema", type: "model" }),
    ]);
  });

  it("splits large symbols while preserving absolute source ranges", () => {
    const body = Array.from(
      { length: 8 },
      (_, index) => `  const value${index} = ${index};`,
    );
    const source = ["export function large() {", ...body, "}"].join("\n");
    const result = new TreeSitterCodeChunker().chunk(source, metadata, {
      chunkSizeLines: 4,
      overlapLines: 1,
    });
    const largeChunks = result.chunks.filter(
      (chunk) => chunk.symbolName === "large",
    );

    expect(largeChunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 4],
      [4, 7],
      [7, 10],
    ]);
    expect(largeChunks.every((chunk) => chunk.symbolType === "function")).toBe(
      true,
    );
  });

  it("falls back safely for syntax errors and unsupported languages", () => {
    const invalid = new TreeSitterCodeChunker().chunk(
      "export function broken(",
      metadata,
    );
    const unsupported = new TreeSitterCodeChunker().chunk("{\"ok\":true}", {
      ...metadata,
      filePath: "package.json",
      language: "json",
    });

    expect(invalid).toMatchObject({
      chunkingStrategy: "line_fallback",
      imports: [],
      exports: [],
      symbols: [],
    });
    expect(invalid.chunks[0]).not.toHaveProperty("symbolName");
    expect(unsupported.chunkingStrategy).toBe("line");
  });
});

describe("RepositoryTreeSitterChunker", () => {
  it("preserves repository safety and reports per-file parsing strategies", async () => {
    const rootDirectory = await fs.mkdtemp(
      path.join(tmpdir(), "tree-sitter-repository-"),
    );
    temporaryDirectories.push(rootDirectory);
    await fs.mkdir(path.join(rootDirectory, "src"));
    await Promise.all([
      fs.writeFile(
        path.join(rootDirectory, "src", "valid.ts"),
        "export function ready() { return true; }",
      ),
      fs.writeFile(
        path.join(rootDirectory, "src", "broken.ts"),
        "export function broken(",
      ),
      fs.writeFile(path.join(rootDirectory, "README.md"), "# Fixture"),
    ]);
    const filtered = await new RepositoryFileFilter().filter(rootDirectory);

    const result = await new RepositoryTreeSitterChunker().chunkFiles(
      filtered.files,
      {
        userId: "user-1",
        repositoryId: "repository-1",
        branch: "main",
        commitSha: "abc123",
      },
    );

    expect(
      result.fileSummaries.map(({ filePath, chunkingStrategy }) => ({
        filePath,
        chunkingStrategy,
      })),
    ).toEqual([
      { filePath: "README.md", chunkingStrategy: "line" },
      { filePath: "src/broken.ts", chunkingStrategy: "line_fallback" },
      { filePath: "src/valid.ts", chunkingStrategy: "tree_sitter" },
    ]);
    expect(result.fileSummaries[2]).toMatchObject({
      imports: [],
      exports: ["ready"],
      symbols: [expect.objectContaining({ name: "ready", type: "function" })],
    });
  });
});
