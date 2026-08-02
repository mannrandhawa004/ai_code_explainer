# GitHub App setup

The GitHub App provides user sign-in, repository authorization, private-repository cloning, and signed push notifications.

## Create and configure the app

Create a GitHub App owned by the account or organization that will operate the service. Configure these values:

- Callback URL: `http://localhost:5000/api/auth/github/callback` locally; use the exact HTTPS API URL in production.
- Webhook URL: expose `POST /api/github/webhook` through a public HTTPS API URL. GitHub cannot deliver directly to `localhost`; use a secure forwarding service only for local development.
- Webhook content type: `application/json`.
- Webhook secret: a random high-entropy value of at least 32 characters; set the identical value in `GITHUB_WEBHOOK_SECRET`.
- Event subscription: subscribe to **Push** only. GitHub Apps receive installation and installation-repository lifecycle events used for access revocation.
- Repository permissions: **Contents: Read-only**. GitHub supplies the metadata permission required for repository discovery.
- User authorization: enable expiring user-to-server tokens. The API persists refresh tokens encrypted and rotates both values when GitHub refreshes them.
- Installation scope: users may install the app on all repositories or selected repositories. The API returns only repositories GitHub reports for that user and installation.

Generate a private key for the app. Do not commit the PEM file or its contents. On a platform that accepts only single-line variables, replace actual PEM line breaks with literal `\n`; the API and worker restore them at startup.

GitHub references: [registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push), [comparing commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits), and [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

## Environment

Copy `.env.example` to `.env` and set:

```text
GITHUB_APP_ID=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY=
GITHUB_CALLBACK_URL=http://localhost:5000/api/auth/github/callback
GITHUB_WEBHOOK_SECRET=
JWT_SECRET=
ENCRYPTION_KEY=
```

Generate `ENCRYPTION_KEY` as an exact 32-byte base64 value with the command documented in `.env.example`. `JWT_SECRET` and `GITHUB_WEBHOOK_SECRET` must each contain at least 32 random characters. The API fails fast if GitHub configuration is partial, a secret is weak/malformed, the webhook secret is absent in production, or production URLs do not use HTTPS. The worker fails fast when only one of `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` is present.

The API and worker need the app ID and private key. Only the API needs the client ID, client secret, callback URL, JWT secret, and encryption key. If they run as separate deployments, give each process only the variables it needs.

## Runtime flow

1. The browser opens `GET /api/auth/github`. The API sets a short-lived HttpOnly state cookie and redirects to GitHub.
2. GitHub returns to `GET /api/auth/github/callback`. The API verifies state, exchanges the temporary code server-side, encrypts the GitHub user and refresh tokens, and sets a signed HttpOnly session cookie.
3. The frontend requests installations, repositories, and branches from `/api/github/*`. GitHub tokens never enter frontend responses.
4. A private import posts its installation ID and optional branch to `/api/github/repositories/:owner/:repository/import`. The API verifies that GitHub currently grants that user access before persisting and queueing it.
5. The queue contains repository identifiers and a canonical credential-free GitHub URL. The worker creates a one-repository, read-only installation token immediately before cloning and removes its temporary credential file afterward.

## Webhook flow

1. GitHub sends a JSON delivery to `POST /api/github/webhook` with `X-GitHub-Delivery`, `X-GitHub-Event`, and `X-Hub-Signature-256`.
2. The API verifies the signature against the exact raw body before parsing JSON. Invalid signatures and malformed payloads never reach Redis or MongoDB.
3. Supported payloads are reduced to repository IDs, installation IDs, branch/commit metadata, a SHA-256 payload hash, and the delivery ID. Raw GitHub payloads are not retained in queue data.
4. The delivery ID is used as the BullMQ job ID. Replays and completed redeliveries are acknowledged without processing twice; a failed delivery may be retried when GitHub manually redelivers the same ID.
5. The webhook worker revalidates current installation access before recording the latest desired commit and queueing indexing. Pushes arriving during an active job are coalesced into that job. Removal or suspension events mark local repositories revoked, cancel in-progress jobs, clear pending commits, and prevent stale workers from restoring ready status.
6. The indexing worker hashes every accepted file in a fresh selected-branch clone and reconciles those hashes with MongoDB. Only added and modified sources are parsed and embedded. Deleted and renamed-away paths are removed from MongoDB and Qdrant; unchanged vectors are promoted to the new commit without regeneration.

GitHub expects a 2xx response within ten seconds, so `GITHUB_WEBHOOK_ENQUEUE_TIMEOUT_MS` defaults to five seconds and cannot exceed eight seconds. GitHub does not automatically retry failed deliveries; inspect failed deliveries in the GitHub App settings and redeliver them after resolving the outage. Queue records remain for 30 days to detect replays and support manual redelivery.

GitHub limits a push payload's commit array to 2,048 commits, and its compare endpoint exposes at most 300 changed files. The worker therefore treats the current safe clone plus persisted hashes as authoritative rather than trusting either potentially truncated list. Existing repositories indexed before per-file chunk counts were stored receive one complete cleanup rebuild, then use selective updates. MongoDB switches `lastIndexedCommit` only after Qdrant reports synchronous completion, and non-ready repository status prevents searches during the update.

Changing `JWT_SECRET` invalidates existing browser sessions. Changing `ENCRYPTION_KEY` makes existing encrypted GitHub tokens unreadable, so users must authorize again; plan key rotation as a migration rather than changing it silently.
