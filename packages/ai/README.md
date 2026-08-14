# AI Services

Reusable Google Gemini, OpenAI, and Ollama integrations for repository indexing and question answering.

The lightweight default is `AI_PROVIDER=google`: `gemini-embedding-2` creates 768-dimension repository and question vectors, while `gemini-2.5-flash-lite` creates grounded, schema-constrained answers. Repository chunks and questions use Google's recommended document/query formatting for code retrieval. The same model and dimensions are always used for indexing and retrieval.

For offline development, `AI_PROVIDER=ollama` uses the low-memory defaults `qwen3-embedding:0.6b` (1,024 dimensions) and `qwen2.5-coder:0.5b`. The local profile caps chat context at 4,096 tokens, output at 800 tokens, repository context at 12,000 characters, history at 3,000 characters, and embedding batches at four inputs with one concurrent request. `OLLAMA_KEEP_ALIVE=2m` releases idle model memory. These settings favor reliability on an 8 GB CPU-only computer over response quality and throughput.

Step 10 adds structured code-chunk embedding text, bounded batching, token-limit enforcement, deterministic result ordering, and validated OpenAI float-vector responses. Step 12 adds question embeddings, deterministic question classification, bounded conversation/repository context, prompt-injection boundaries, and grounded answer generation through the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses). Step 13 uses [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) to require independently cited answer segments. The application validates every source ID and renders file/line citations from retrieved metadata instead of trusting model-written paths or ranges.

The defaults use `text-embedding-3-small`, 1,536 dimensions, batches of 50 inputs, and two concurrent requests. Inputs are counted with the model family's `cl100k_base` tokenizer and partitioned below the official 8,192-token per-input and 300,000-token per-request limits described by the [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create).

Every provider has separate limits, so Google free-tier batching remains conservative and the OpenAI or optional Ollama settings cannot affect it. Provider responses are validated through the same shared embedding and grounded-answer contracts.

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

Answer generation defaults to configurable `gpt-5.6-sol`, medium reasoning, current-turn reasoning context, medium verbosity, and `store: false`. Run its separate live test only when explicitly needed:

```powershell
$env:RUN_OPENAI_ANSWER_TESTS="true"
$env:OPENAI_API_KEY="your-key"
npm run test --workspace @codebase-explainer/ai -- --run test/openai-answer.integration.test.ts
```
