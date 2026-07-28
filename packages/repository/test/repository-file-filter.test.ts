import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RepositoryFileFilter,
  RepositoryFileFilterError,
} from "../src/index.js";

async function writeFixture(
  rootDirectory: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const absolutePath = path.join(rootDirectory, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

describe("RepositoryFileFilter", () => {
  let rootDirectory: string;

  beforeEach(async () => {
    rootDirectory = await fs.mkdtemp(path.join(tmpdir(), "filter-root-"));
  });

  afterEach(async () => {
    await fs.rm(rootDirectory, { recursive: true, force: true });
  });

  it("keeps supported source files and prunes dependency and build directories", async () => {
    const supportedFiles = [
      "src/app.js",
      "src/component.jsx",
      "src/index.ts",
      "src/page.tsx",
      "package.json",
      "README.md",
      "src/app.css",
      "src/theme.scss",
      "public/index.html",
    ];

    await Promise.all(
      supportedFiles.map((file) => writeFixture(rootDirectory, file, "source")),
    );
    await writeFixture(rootDirectory, "notes.txt", "unsupported");

    for (const directory of [
      ".git",
      "node_modules",
      "dist",
      "build",
      ".next",
      "coverage",
      "vendor",
      "tmp",
      "temp",
    ]) {
      await writeFixture(rootDirectory, `${directory}/hidden.ts`, "hidden");
    }

    const result = await new RepositoryFileFilter().filter(rootDirectory);

    expect(result.files.map((file) => file.relativePath)).toEqual(
      [...supportedFiles].sort(),
    );
    expect(result.exclusions).toContainEqual({
      relativePath: "notes.txt",
      kind: "file",
      reason: "unsupported_extension",
    });
    expect(
      result.exclusions.filter(
        (exclusion) => exclusion.reason === "default_ignored_directory",
      ),
    ).toHaveLength(9);
    expect(result.totalBytes).toBe(supportedFiles.length * "source".length);
  });

  it("applies root gitignore rules and negations", async () => {
    await writeFixture(
      rootDirectory,
      ".gitignore",
      ["ignored/", "*.ts", "!keep.ts", "generated/*", "!generated/keep.ts"].join(
        "\n",
      ),
    );
    await writeFixture(rootDirectory, "ignored/drop.ts", "drop");
    await writeFixture(rootDirectory, "drop.ts", "drop");
    await writeFixture(rootDirectory, "keep.ts", "keep");
    await writeFixture(rootDirectory, "generated/drop.ts", "drop");
    await writeFixture(rootDirectory, "generated/keep.ts", "keep");

    const result = await new RepositoryFileFilter().filter(rootDirectory);

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "generated/keep.ts",
      "keep.ts",
    ]);
    expect(result.exclusions).toContainEqual({
      relativePath: "ignored",
      kind: "directory",
      reason: "gitignore",
    });
    expect(result.exclusions).toContainEqual({
      relativePath: ".gitignore",
      kind: "file",
      reason: "gitignore_file",
    });
  });

  it("loads nested gitignore rules before any sibling file is evaluated", async () => {
    await writeFixture(
      rootDirectory,
      "src/.gitignore",
      "*.ts\n!important.ts\n",
    );
    await writeFixture(rootDirectory, "src/.before-gitignore.ts", "drop");
    await writeFixture(rootDirectory, "src/important.ts", "keep");
    await writeFixture(rootDirectory, "src/z-last.ts", "drop");
    await writeFixture(rootDirectory, "outside.ts", "keep");

    const result = await new RepositoryFileFilter().filter(rootDirectory);

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "outside.ts",
      "src/important.ts",
    ]);
  });

  it("adds custom ignored directories without disabling security defaults", async () => {
    await writeFixture(rootDirectory, ".git/config.ts", "hidden");
    await writeFixture(rootDirectory, "generated-docs/page.ts", "hidden");
    await writeFixture(rootDirectory, "src/page.ts", "source");

    const result = await new RepositoryFileFilter().filter(rootDirectory, {
      additionalIgnoredDirectoryNames: ["generated-docs"],
    });

    expect(result.files.map((file) => file.relativePath)).toEqual(["src/page.ts"]);
    expect(result.exclusions).toContainEqual({
      relativePath: ".git",
      kind: "directory",
      reason: "default_ignored_directory",
    });
    expect(result.exclusions).toContainEqual({
      relativePath: "generated-docs",
      kind: "directory",
      reason: "default_ignored_directory",
    });
  });

  it("excludes secrets, generated assets, lock files, and oversized files with reasons", async () => {
    await writeFixture(rootDirectory, ".env", "SECRET=value");
    await writeFixture(rootDirectory, ".env.production", "SECRET=value");
    await writeFixture(rootDirectory, "credentials.json", "{}");
    await writeFixture(rootDirectory, "server.pem", "secret");
    await writeFixture(rootDirectory, "package-lock.json", "{}");
    await writeFixture(rootDirectory, "app.min.js", "minified");
    await writeFixture(rootDirectory, "app.js.map", "map");
    await writeFixture(rootDirectory, "large.ts", "12345");
    await writeFixture(rootDirectory, "key.ts", "safe");

    const result = await new RepositoryFileFilter().filter(rootDirectory, {
      maxFileBytes: 4,
    });
    const reasons = new Map(
      result.exclusions.map((exclusion) => [
        exclusion.relativePath,
        exclusion.reason,
      ]),
    );

    expect(result.files.map((file) => file.relativePath)).toEqual(["key.ts"]);
    expect(reasons.get(".env")).toBe("secret_file");
    expect(reasons.get(".env.production")).toBe("secret_file");
    expect(reasons.get("credentials.json")).toBe("secret_file");
    expect(reasons.get("server.pem")).toBe("secret_file");
    expect(reasons.get("package-lock.json")).toBe("lock_file");
    expect(reasons.get("app.min.js")).toBe("generated_file");
    expect(reasons.get("app.js.map")).toBe("generated_file");
    expect(reasons.get("large.ts")).toBe("file_too_large");
  });

  it("rejects binary content without rejecting empty, unicode, or split UTF-8 text", async () => {
    await writeFixture(rootDirectory, "invalid-utf8.ts", new Uint8Array([0xff, 0xfe]));
    await writeFixture(rootDirectory, "nul.ts", new Uint8Array([65, 0, 66]));
    await writeFixture(rootDirectory, "empty.ts", "");
    await writeFixture(rootDirectory, "unicode.ts", "€const value = 1;");

    const result = await new RepositoryFileFilter().filter(rootDirectory, {
      binarySampleBytes: 2,
    });

    expect(result.files.map((file) => file.relativePath)).toEqual([
      "empty.ts",
      "unicode.ts",
    ]);
    expect(result.exclusions).toContainEqual({
      relativePath: "invalid-utf8.ts",
      kind: "file",
      reason: "binary_file",
    });
    expect(result.exclusions).toContainEqual({
      relativePath: "nul.ts",
      kind: "file",
      reason: "binary_file",
    });
  });

  it("enforces the filtered file count before opening file contents", async () => {
    await writeFixture(rootDirectory, "a.ts", "a");
    await writeFixture(rootDirectory, "b.ts", "b");

    await expect(
      new RepositoryFileFilter().filter(rootDirectory, { maxFiles: 1 }),
    ).rejects.toMatchObject({ code: "MAX_FILES_EXCEEDED" });
  });

  it("enforces the filtered repository byte limit", async () => {
    await writeFixture(rootDirectory, "a.ts", "123");
    await writeFixture(rootDirectory, "b.ts", "456");

    await expect(
      new RepositoryFileFilter().filter(rootDirectory, { maxTotalBytes: 5 }),
    ).rejects.toMatchObject({ code: "MAX_TOTAL_BYTES_EXCEEDED" });
  });

  it("validates limits and supports cancellation", async () => {
    await expect(
      new RepositoryFileFilter().filter(rootDirectory, { maxFiles: 0 }),
    ).rejects.toBeInstanceOf(RepositoryFileFilterError);

    const controller = new AbortController();
    controller.abort();

    await expect(
      new RepositoryFileFilter().filter(rootDirectory, {
        scanOptions: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "FILTER_ABORTED" });
  });

  it("preserves the scanner's invalid-root error", async () => {
    const filePath = path.join(rootDirectory, "not-a-directory.ts");
    await fs.writeFile(filePath, "source");

    await expect(
      new RepositoryFileFilter().filter(filePath),
    ).rejects.toMatchObject({ code: "INVALID_ROOT" });
  });
});
