# Repository Processing

Safe, reusable repository ingestion primitives shared by the API and indexing worker.

Step 6 introduces public GitHub repository cloning. Later steps add scanning, filtering, parsing, and chunking to this package.

The cloner accepts only canonical public `https://github.com/owner/repository` URLs. It disables inherited Git configuration and credential prompts, rejects unsafe branch names and protocols, creates a depth-one single-branch clone, and removes the temporary source tree whether processing succeeds or fails.

Run the real public GitHub integration test from the repository root:

```powershell
$env:RUN_GITHUB_CLONE_TESTS="true"
npm run test --workspace @codebase-explainer/repository
```
