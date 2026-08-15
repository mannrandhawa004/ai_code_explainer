# CI/CD and Release Guide

The automation is provider-neutral and keeps validation, image publication, and deployment as separate trust boundaries. All third-party GitHub Actions references are pinned to immutable commit SHAs and Dependabot proposes their updates.

## Workflows

| Workflow | Trigger | Responsibility |
|---|---|---|
| `CI` | Pull requests and pushes to `main`, manual | Locked install, workflow validation, dependency audit, lint, type-check, all tests, production build, backend runtime check, and Compose validation. |
| `Container security` | Pull requests and pushes to `main`, weekly, manual | Trivy repository and API/worker image scans for high/critical vulnerabilities, secrets, and misconfiguration. |
| `Release backend images` | `v*.*.*` tags or manual from `main` | Scan before publication, push matching API/worker images to GHCR, attach SBOMs, and publish GitHub provenance attestations. |
| `Deploy released images` | Manual | Use a protected `staging` or `production` environment, call an HTTPS deployment hook, and poll configured health URLs. |

Run the local workflow checks before pushing:

```powershell
npm ci
npm run ci:validate
npm audit --audit-level=high
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:backend-runtime
npm run containers:config
```

`ci:validate` rejects malformed YAML, mutable action references, missing job timeouts, `pull_request_target`, and secrets interpolated directly into shell scripts. CI additionally runs the checksummed actionlint binary.

## Repository settings

1. Enable GitHub Actions and allow the workflow `GITHUB_TOKEN` to write packages and attestations.
2. Protect `main` and require the CI and container-security jobs before merging.
3. Create `staging` and `production` GitHub environments.
4. Restrict environment deployment branches to `main`; add a required reviewer to `production` when the repository plan supports it.
5. Keep GitHub secret scanning and code scanning enabled. Trivy uploads SARIF when code scanning is available, but the scan command itself remains the release gate.

The workflows never run privileged release or deployment credentials for pull requests. Checkout credentials are not persisted, permissions are declared explicitly, and manual releases are accepted only from `main`.

## Deployment environment configuration

Configure these separately in both GitHub environments:

| Name | Kind | Required | Purpose |
|---|---|:---:|---|
| `DEPLOY_HOOK_URL` | Secret | Yes | HTTPS endpoint for the chosen hosting platform or deployment controller. |
| `DEPLOY_HOOK_TOKEN` | Secret | No | Bearer token sent to the deployment hook. |
| `FRONTEND_DEPLOY_HOOK_URL` | Secret | No | Vercel-compatible deploy hook; omit when Git integration deploys `main` automatically. |
| `API_HEALTH_URL` | Variable | Yes | Public HTTPS API liveness URL ending in `/api/health`. |
| `WORKER_HEALTH_URL` | Variable | No | HTTPS worker `/health` URL when reachable from GitHub-hosted runners. |
| `FRONTEND_HEALTH_URL` | Variable | No | Public HTTPS frontend URL. |

The deployment hook receives this JSON contract:

```json
{
  "environment": "staging",
  "version": "1.0.0",
  "apiImage": "ghcr.io/owner/repository-api:1.0.0",
  "workerImage": "ghcr.io/owner/repository-worker:1.0.0",
  "sourceSha": "the workflow commit SHA"
}
```

The backend hook must return a successful HTTP status after accepting the rollout. It should update both backend services to the supplied version, preserve all secrets in the hosting platform's secret manager, and return a failure status when either service cannot be scheduled. The optional frontend hook runs next; when it is absent, the workflow assumes the frontend platform deploys `main` through its Git integration. The workflow then retries health checks while the rollout completes.

This contract works with a small deployment-controller endpoint, a platform automation function, or an HTTPS adapter around Render, Railway, Fly.io, AWS ECS, Kubernetes, or another container host. Do not put platform credentials in the hook URL; use the optional bearer token and the GitHub environment secret store.

## Create a release

After the feature branches are merged and `main` is green, create and push a semantic version tag:

```powershell
git switch main
git pull --ff-only
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

The release publishes:

```text
ghcr.io/mannrandhawa004/ai_code_explainer-api:1.0.0
ghcr.io/mannrandhawa004/ai_code_explainer-worker:1.0.0
```

Stable releases also receive `latest`; prereleases do not. Every image also receives a full commit-SHA tag. Never deploy `latest` to production—select the explicit version in the `Deploy released images` workflow.

For public repositories, verify GitHub's image provenance with:

```powershell
gh attestation verify oci://ghcr.io/mannrandhawa004/ai_code_explainer-api:1.0.0 -R mannrandhawa004/ai_code_explainer
gh attestation verify oci://ghcr.io/mannrandhawa004/ai_code_explainer-worker:1.0.0 -R mannrandhawa004/ai_code_explainer
```

## Rollback

Run `Deploy released images` again with the previous known-good version. Roll back API and worker together because they are built from one commit. Keep the previous images in GHCR until their replacement has passed the staging recovery and evaluation gates.
