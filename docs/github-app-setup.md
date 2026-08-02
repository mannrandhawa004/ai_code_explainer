# GitHub App setup

Step 17 uses a GitHub App for user sign-in, repository authorization, and private-repository cloning. Webhook delivery is intentionally deferred to Step 18.

## Create and configure the app

Create a GitHub App owned by the account or organization that will operate the service. Configure these values:

- Callback URL: `http://localhost:5000/api/auth/github/callback` locally; use the exact HTTPS API URL in production.
- Repository permissions: **Contents: Read-only**. GitHub supplies the metadata permission required for repository discovery.
- User authorization: enable expiring user-to-server tokens. The API persists refresh tokens encrypted and rotates both values when GitHub refreshes them.
- Installation scope: users may install the app on all repositories or selected repositories. The API returns only repositories GitHub reports for that user and installation.

Generate a private key for the app. Do not commit the PEM file or its contents. On a platform that accepts only single-line variables, replace actual PEM line breaks with literal `\n`; the API and worker restore them at startup.

GitHub references: [registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), and [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Environment

Copy `.env.example` to `.env` and set:

```text
GITHUB_APP_ID=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY=
GITHUB_CALLBACK_URL=http://localhost:5000/api/auth/github/callback
JWT_SECRET=
ENCRYPTION_KEY=
```

Generate `ENCRYPTION_KEY` as an exact 32-byte base64 value with the command documented in `.env.example`. `JWT_SECRET` must contain at least 32 random characters. The API fails fast if GitHub configuration is partial, either secret is weak/malformed, or production URLs do not use HTTPS. The worker fails fast when only one of `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY` is present.

The API and worker need the app ID and private key. Only the API needs the client ID, client secret, callback URL, JWT secret, and encryption key. If they run as separate deployments, give each process only the variables it needs.

## Runtime flow

1. The browser opens `GET /api/auth/github`. The API sets a short-lived HttpOnly state cookie and redirects to GitHub.
2. GitHub returns to `GET /api/auth/github/callback`. The API verifies state, exchanges the temporary code server-side, encrypts the GitHub user and refresh tokens, and sets a signed HttpOnly session cookie.
3. The frontend requests installations, repositories, and branches from `/api/github/*`. GitHub tokens never enter frontend responses.
4. A private import posts its installation ID and optional branch to `/api/github/repositories/:owner/:repository/import`. The API verifies that GitHub currently grants that user access before persisting and queueing it.
5. The queue contains repository identifiers and a canonical credential-free GitHub URL. The worker creates a one-repository, read-only installation token immediately before cloning and removes its temporary credential file afterward.

Changing `JWT_SECRET` invalidates existing browser sessions. Changing `ENCRYPTION_KEY` makes existing encrypted GitHub tokens unreadable, so users must authorize again; plan key rotation as a migration rather than changing it silently.
