# Database

MongoDB connection utilities and Mongoose models shared by the API and indexing worker.

The package owns connection lifecycle, readiness checks, indexes, validation, and the User, Repository, RepositoryFile, Symbol, Conversation, Message, and IndexingJob models.

Start local MongoDB from the repository root:

```powershell
docker compose up -d mongodb
```

Run the database integration test against it:

```powershell
$env:MONGODB_TEST_URI="mongodb://localhost:27017/codebase_explainer_test"
npm run test --workspace @codebase-explainer/database
```
