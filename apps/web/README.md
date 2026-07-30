# Web

Next.js App Router frontend for grounded repository conversations.

## Current routes

```text
/                                    Repository workspace launcher
/repositories/:repositoryId/chat     Cited repository chat
```

The chat interface calls `POST /api/repositories/:repositoryId/chat` with cookie credentials, continues the returned conversation ID, renders safe GitHub-flavored Markdown and code, and displays only API-validated file/line sources. Authentication remains fail-closed until the GitHub authentication step supplies the session cookie.

Set the browser-visible API origin in the root environment file:

```text
NEXT_PUBLIC_API_URL=http://localhost:5000
```

Run from the repository root:

```powershell
npm run dev --workspace @codebase-explainer/web
npm test --workspace @codebase-explainer/web
npm run lint --workspace @codebase-explainer/web
npm run build --workspace @codebase-explainer/web
```
