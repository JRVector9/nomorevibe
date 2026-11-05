# PR5: vector, rerank and session constraints

This review uses source at PR1 `106d8e37`. It does not inspect production,
contact a model server, run parity measurement, change a model/capacity, or enable
a pool. It adds a UI-safe explanation to the existing shared capability API.
The capability predicate and execution paths remain unchanged.

## Decision by actual execution path

| Task | Execution source | Decision |
| --- | --- | --- |
| product-embedding | `refreshProductEmbeddings` → `embedTexts` | Pool remains unavailable: no per-connection replica proof is consumed. |
| search-embedding | `rankSearch` → `embedQuery` → the same `embedTexts` | Must remain in the product vector space; no independently verified replica configuration is read. |
| search-rerank | `rankSearch` → `rerankDocuments` | Pool remains unavailable: response validity is checked, but no per-endpoint model/scoring-equivalence contract is consumed. |
| grok-session-check | `checkGrokSession` → one selected Grok CLI invocation | Session maintenance, not work distribution. No additional ping or concurrency. |

A matching model ID in `ai_connections`, a matching dimension count or two
successful `/models` responses cannot establish identical vector/scoring space.
The declared task constraints `sameModelAcrossRanks` and `sameModelAs` are model
name checks; they do not add runtime replica evidence.

## Existing embedding contract

[embedding.ts](../../lib/domain/products/embedding.ts) fixes:

- Model tag `bge-m3-f16@daec91ff` and the full GGUF SHA256
  `daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c`.
- 1024 dimensions, the exact product-document SQL and raw query preprocessing,
  CLS pooling and halfvec cosine distance; preprocessing has a computed hash.
- An explicit serving-profile check for matching model/file revision/dimensions/
  preprocessing, with at least 32 parity samples and minimum cosine 0.999.

These are existing thresholds, not new measurement results.
`EMBEDDING_SERVING_PROFILE` is one process setting, and its schema contains no
endpoint identity. `embeddingReadiness` compares that one profile with code
constants; it is not a registry of separately proven connection replicas.
`embedTexts` reads `EMBEDDING_URL` (or an explicit call option), sends the input
texts, and validates response count, finite values and dimensions. It does not
consume the task pool or attest a newly selected connection's file revision.
The absence of the optional serving-profile setting retains existing legacy
behavior; this PR does not reinterpret that as replica verification.

[embedding-refresh.ts](../../lib/jobs/products/embedding-refresh.ts) processes
existing batches of 64, stores the fixed model tag and current text hash, and
writes through the existing job lease boundary. No batch/concurrency/storage
changes are made here.

[productEmbeddings](../../lib/db/schema.ts) stores one row per product with
`halfvec(1024)`. [nearestProductSlugs](../../lib/domain/products/repository.ts) uses
the stored model tag and `<=>` halfvec cosine distance. A new server returning
1024 numbers is insufficient proof that those numbers belong in that table.
This PR does not change the model tag, document hash, distance query, storage,
or any index definition, and does not describe an unverified HNSW index.

The existing [parity tool](../../scripts/embedding-parity.ts) can compare current
stored vectors with a specified endpoint. Its own documentation says it cannot
verify the model file SHA; the operator must verify that separately. No parity
command or model call was executed for this PR. Safe replica routing requires
endpoint-specific file/revision, preprocessing/pooling and parity evidence tied
to both product and query execution before opening this capability.

## Existing rerank contract

[hybrid-search.ts](../../lib/domain/products/hybrid-search.ts) sends one query and
its complete document set to one `RERANK_URL`, validates indexes/finite scores,
and sorts that response. It does not average multiple models' scores. On failure
it retains the fused search order. These behaviors remain unchanged.

[search-models.sh](../../scripts/ops/search-models.sh) pins the default local
reranker GGUF and llama-server download hashes. That installation source is not
an attestation of an arbitrary registered API endpoint: the runtime request has
no endpoint-specific revision/preprocessing/scoring-profile verification. No
new pool URL, profile field, self-reported model-name exception or fake replica
is added. Each replica needs independently bound model and scoring evidence
before any workload selection can be connected safely.

## Grok is not a throughput pool

[grok-session.ts](../../lib/crawl/jobs/grok-session.ts) selects one usable Grok
rank, calls the existing short session-check command once, and records the
result against the current instance. It exists to maintain the CLI login session
at its authentication path. Its fallback, capacity/lease rules, cadence,
prompt, command and observation remain unchanged. Repeating the check for pool
members would add calls without distributing product work.

## Shared UI contract and validation

`aiTaskWorkloadPoolUnsupportedReason(taskId, slot?)` in
[ai-task-execution-config.ts](../../lib/llm/ai-task-execution-config.ts) explains
the vector, rerank and session restrictions. It returns null only when the
existing capability predicate allows the task. PR4 can extend that predicate
only after connecting a real adapter; this explanation does not enable one.
The root UI can display the same server-derived reason alongside unavailable
mode controls instead of implying that saved names are sufficient proof.

No new tests or manual functional tests were added/run. No models were called,
no operating data or configuration was read, and no migration/deployment was
performed. Only the changed source's necessary static lint check is used; its
actual result is recorded with the PR. Required repository CI remains unchanged.
