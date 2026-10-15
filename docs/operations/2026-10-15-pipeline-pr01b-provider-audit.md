# PR01b provider capability audit — 2026-10-15

Real-model replay remains closed. The local gateway source explains several limits of the available metadata, but does not establish the deployed gateway revision or a provider-enforced total-token bound for the configured review pair:

- AI1: `[MLX] gpt-oss-120b`
- AI2: `[supa] Qwen3.8-27B-NVFP4`

## Evidence boundary

Read-only source audit of the clean local `abcLLM` checkout at HEAD `fc0f972ac1608ab8a8c822edd5f3d9f4a0f7fdac` (`fc0f972`, 2026-09-25). All `backend/...` and `docs/extra-servers.md` references below are paths in that other repository. No files there were changed. No inference, deployment, secret environment-file inspection, or production admin request was performed for this source audit.

The earlier safe gateway readback showed the two display names, `backend: vllm`, context metadata, static OpenAPI version `1.0.0`, and health status. AI1's advertised context changed between reads (32768 and 8192); AI2 advertised 32768. Those observations do not bind this local checkout to the running service.

## Completion path and upstream attempts

NoMoreVibe's `lib/crawl/agent-review-gateway.ts:127–143` sends `/v1/chat/completions` with `stream:false`, `max_tokens:3000`, `context_strategy:raw`, low reasoning effort, a disable-thinking template option, and a JSON-schema response format.

In the audited gateway:

- `backend/main.py:84` mounts the OpenAI router at `/v1`. `backend/app/routers/ollama_proxy.py:1529–1555` parses the request, resolves the display model, and enters the MLX/vLLM route.
- Even `stream:false` is converted to an upstream streaming request with `include_usage:true` (`ollama_proxy.py:1726–1778`). Both client streaming modes call `vllm_client.chat_stream_with_fallback` (`ollama_proxy.py:1644–1645`, `1776–1778`).
- `backend/app/services/vllm_client.py:135–164` issues one streaming POST. Its wrapper at `167–178` retries once after an upstream HTTP 400/422 if `chat_template_kwargs` was present, removing that field for the second POST. There is no further loop in this wrapper.
- `ollama_proxy.py:361–370` adds `chat_template_kwargs.enable_thinking:false` for Qwen/EXAONE. Consequently, the AI2 route can issue **two upstream POSTs per gateway request**, and the second no longer requests disabled thinking. The initial rejected attempt is not proven to consume zero provider work. A resolved gpt-oss route receives no such option and has one POST in this local wrapper.
- The current completion route rejects a missing model instead of choosing another model (`ollama_proxy.py:1558–1565`). The separate `mlx_discovery.get_fallback` helper (`433–440`) is not called by this route. This does not prove that an upstream proxy, engine, or deployed intermediary has no retries.

## Routing and serving metadata

`[supa]` and `[MLX]` are display/routing hints, not pinned upstream identities. Prefixes are stripped (`ollama_proxy.py:80–96`), then model aliases select a server (`200–233`). Discovery scans M3 ports before extra servers and keeps the first colliding alias (`backend/app/services/mlx_discovery.py:268–295`). `docs/extra-servers.md:12` explicitly describes M3 precedence on collision.

The model-list `backend:vllm` value is hardcoded for every discovered MLX/vLLM entry (`ollama_proxy.py:1430–1448`); `/v1/models` similarly emits `owned_by:vllm` (`2055–2069`). Neither field identifies the actual engine serving AI1.

For M3 entries, advertised context comes from model-name rules and `DEFAULT_NUM_CTX` (`ollama_proxy.py:573–601`), not an upstream enforcement check. For extra-server entries, it copies cached upstream `max_model_len`, with recommended prompt size computed as three quarters (`592–600`; `mlx_discovery.py:287–300`, `345–357`). The listing's `created` value is the listing time (`ollama_proxy.py:2031`, `2068`).

`docs/extra-servers.md:3–14` records a September 25 gateway deployment through `e5efc7c`, M3 mlx-lm/mlx-vlm with an `mlx_proxy`, and supa vLLM 0.30.0 serving `Inferact/Qwen3.8-27B-NVFP4` with `--max-model-len 32768`, `--max-num-seqs 64`, and `qwen3_xml`. This is dated operational documentation, not current process/configuration readback or a weights/tokenizer/template revision. The gateway Dockerfile has no source-revision label (`backend/Dockerfile:1–7`); OpenAPI uses static version 1.0.0 (`backend/main.py:61`), and health returns status/Redis state only (`91–102`).

## Token, reasoning, input, and usage limitations

- `ChatRequest` declares `max_tokens` and `max_completion_tokens` as optional integers (`backend/app/models/ollama.py:86–101`). The forwarding whitelist maps either to upstream `max_tokens`, preferring `max_tokens` (`ollama_proxy.py:373–383`). This forwards an output request; it does not prove how the running engine accounts for prompt tokens, hidden reasoning, templates, or total sequence length.
- `reasoning_effort`, caller `chat_template_kwargs`, `response_format`, `stream_options`, `n`, and `best_of` are absent from `ChatRequest` and are not forwarded by that whitelist. Thus NoMoreVibe's low-reasoning and JSON-schema fields do not establish provider enforcement in this checkout. The gateway independently injects the Qwen thinking option described above. `<think>` stripping filters returned text, not generation cost (`ollama_proxy.py:810–825`, `1773–1788`).
- `_truncate_messages` runs before routing (`ollama_proxy.py:1541`), including when `context_strategy:raw` is requested. The helper can remove old messages according to runtime `MAX_CONTEXT_CHARS` (`765–807`); its local default is 0, meaning disabled (`backend/app/config.py:30`). It preserves system messages and at least one recent message, so it is neither an exact token counter nor a hard total-input bound. The current two-message review shape alone does not demonstrate deployed truncation behavior.
- The gateway's explicit input cap and adaptive summaries are Gemma-specific (`ollama_proxy.py:261–273`, `302–319`, `419–438`). They do not bound the configured gpt-oss/Qwen pair. Preflight quota uses character-based estimates (`50–67`, `1744–1749`).
- If upstream usage is absent but content exists, the non-stream route constructs ordinary-looking `usage` from character estimates (`ollama_proxy.py:1814–1844`), without a provenance flag. Completion estimation uses already filtered visible content. A returned `usage` object therefore cannot authenticate actual prompt/output/reasoning consumption or all attempts.
- `httpx` has connect/write/pool/read timeouts, including a 600-second read timeout (`vllm_client.py:95–104`), but the completion path supplies no total generation deadline or acknowledged engine cancellation. NoMoreVibe's abort signal bounds its own waiting; it does not prove upstream work stopped.

## Evidence still required before provider admission

Keep both configured models. Before enabling their existing review consumers for isolated replay, obtain and bind the following to the running route rather than accepting caller flags or local documentation:

1. Deployed gateway image/source revision and upstream engine/build identity; resolved server, full served model, weights revision, tokenizer revision, and chat-template/configuration revision. Alias display names alone are insufficient.
2. Audited enforcement of a hard total bound covering prompt/template tokens plus **all** generated tokens, including hidden reasoning and all generated sequences. Prove oversize behavior and absence of silent input changes. A reported `context_length` or requested `max_tokens` alone is insufficient.
3. A bounded count of upstream attempts across the gateway and serving proxy/engine. Prefer a strict single-attempt path through the existing gateway. If retries remain, include every attempt in the durable reservation and prove that fallback preserves the fixed model/input/policy/reasoning conditions. The existing Qwen option-removal fallback changes those conditions.
4. Usage provenance distinguishing actual engine counters from estimates, including reasoning/all attempts, or retain the full proven reservation without treating synthetic usage as a receipt. Missing/unknown outcomes must keep admission closed and reservations charged.
5. Current readback binding those proofs to this run, with explicit timeout/cancellation semantics. A client timeout must leave possible ongoing work indeterminate; it must not free budget or support a sealed/completed-run claim.

A conservative reservation of `proven total tokens per attempt × proven maximum attempts` becomes usable only after both factors and the fixed execution conditions are established. This audit supplies source findings, not that proof. No provider change or deployment is included in this PR01b checkpoint.
