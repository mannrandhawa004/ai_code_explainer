# AI Services

Reusable model-provider integrations for repository indexing and question answering.

Step 10 adds structured code-chunk embedding text, bounded batching, token-limit enforcement, deterministic result ordering, and validated OpenAI float-vector responses. Provider credentials are read only when constructing the runtime service and are never stored in source control.

The defaults use `text-embedding-3-small`, 1,536 dimensions, batches of 50 inputs, and two concurrent requests. Inputs are counted with the model family's `cl100k_base` tokenizer and partitioned below the official 8,192-token per-input and 300,000-token per-request limits described by the [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

Run local tests from the repository root:

```powershell
npm run test --workspace @codebase-explainer/ai
```

The live provider test is opt-in and requires a valid key:

```powershell
$env:RUN_OPENAI_EMBEDDING_TESTS="true"
$env:OPENAI_API_KEY="your-key"
npm run test --workspace @codebase-explainer/ai -- --run test/openai-embedding.integration.test.ts
```
