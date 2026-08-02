# Repository Processing

Safe, reusable repository ingestion primitives shared by the API and indexing worker.

Step 6 introduces public GitHub repository cloning. Step 7 adds bounded, deterministic file discovery without following symbolic links. Step 8 adds secure source-file filtering. Step 9 adds deterministic line-based source chunking. Step 16 adds Tree-sitter AST parsing and symbol-aware chunks.

The cloner accepts only canonical public `https://github.com/owner/repository` URLs. It disables inherited Git configuration and credential prompts, rejects unsafe branch names and protocols, creates a depth-one single-branch clone, and removes the temporary source tree whether processing succeeds or fails.

Run the real public GitHub integration test from the repository root:

```powershell
$env:RUN_GITHUB_CLONE_TESTS="true"
npm run test --workspace @codebase-explainer/repository
```

Run the real clone-and-scan integration test with:

```powershell
$env:RUN_GITHUB_SCAN_TESTS="true"
npm run test --workspace @codebase-explainer/repository
```

## File filtering

`RepositoryFileFilter` layers deterministic filtering over the scanner. It:

- applies root and nested `.gitignore` rules, including negations;
- prunes dependency, VCS, cache, coverage, and build directories;
- rejects environment/credential files, lock files, generated assets, unsupported extensions, oversized files, and binary content;
- enforces configurable 5,000-file, 100 MB repository, and 500 KB per-file defaults; and
- bounds concurrent binary inspection without reading whole files into memory.

Run the real clone-and-filter integration test with:

```powershell
$env:RUN_GITHUB_FILTER_TESTS="true"
npm run test --workspace @codebase-explainer/repository
```

## Line-based chunking

`LineBasedChunker` uses the guide defaults of 120 lines with 20 lines of overlap. Every chunk receives deterministic UUID-compatible identity, repository/commit/file metadata, exact one-based line ranges, normalized line endings, language metadata, and a SHA-256 content hash.

`RepositoryLineBasedChunker` safely reads Step 8's filtered files with bounded concurrency, validates the complete source as UTF-8, and enforces per-file and repository-wide byte, character, and chunk limits. It never executes repository code.

Run the real clone-filter-chunk integration test with:

```powershell
$env:RUN_GITHUB_CHUNK_TESTS="true"
npm run test --workspace @codebase-explainer/repository
```

## Tree-sitter chunking

`TreeSitterCodeChunker` parses JavaScript, JSX, TypeScript, and TSX without executing repository code. It extracts imports, exports, references, functions, arrow functions, classes, methods, interfaces, type aliases, enums, React components, Express routes, controllers, services, and models with one-based source ranges.

`RepositoryTreeSitterChunker` is the worker-facing implementation. It preserves all repository byte, character, concurrency, cancellation, and chunk limits from line chunking. Unsupported languages use line chunks, and JavaScript/TypeScript files with parser errors or excessive AST size fall back to line chunks instead of failing the complete indexing job.
