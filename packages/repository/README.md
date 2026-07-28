# Repository Processing

Safe, reusable repository ingestion primitives shared by the API and indexing worker.

Step 6 introduces public GitHub repository cloning. Step 7 adds bounded, deterministic file discovery without following symbolic links. Step 8 adds secure source-file filtering. Later steps add parsing and chunking to this package.

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
