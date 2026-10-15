# PR01b provider capability audit — 2026-10-15

Real-model replay remains closed. The original source audit below did not establish the deployed gateway revision or a provider-enforced total-token bound for the configured review pair. The later [running-service readback](#running-service-readback--2026-10-15) binds eight audited gateway files to both running containers and identifies current upstream metadata, but still does not establish the required provider budget contract:

- AI1: `[MLX] gpt-oss-120b`
- AI2: `[supa] Qwen3.8-27B-NVFP4`

## Original source-audit evidence boundary

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

## Running-service readback — 2026-10-15

This follow-up is separate from the original local-only audit. After collecting the following evidence, `clock__curr_time` returned **2026-10-15 11:42:02 UTC / 20:42:02 KST**. The work used only Dokploy metadata GETs, SSH/Docker metadata and file-hash reads, and upstream metadata GETs. There were **zero inference requests, deployments, configuration changes, production DB writes, or gateway-source changes**. These are operational observations, not a token-enforcement or cancellation test. No test suite was executed for this documentation task.

### Deployment records and running gateway files

Authenticated Dokploy `GET application.one?applicationId=...` and `GET deployment.all?applicationId=...` returned both backends on GitHub `main`, `applicationStatus:done`, and `autoDeploy:true`. Only allowlisted non-secret fields were printed; raw application responses, which contain environment secrets, were never printed or saved. The latest deployment records agree with the dated handoff's environment-only redeployment, but contain no commit-hash field:

| Gateway | Latest deployment ID | Started UTC | Finished UTC | Status |
| --- | --- | --- | --- | --- |
| M3 | `Uu9rzYhupKFTUbjsyM47Q` | 2026-09-24 23:33:18.731 | 23:33:29.564 | done |
| mini | `vnPaCWCBYGMtVgohRiw_n` | 2026-09-24 23:33:18.825 | 23:33:28.744 | done |

The preceding code-deployment records are M3 `BATmBMnCqUetJ-qXrmBmW` and mini `Nb2zmROT1Dmu4O5-lUudk`, both started at 23:21:40 UTC on September 24 and marked done. A deployment's `done` value alone is not serving-code evidence. Direct inspection separately identified the running containers:

| Gateway | Container ID | Image content ID | Container started UTC |
| --- | --- | --- | --- |
| M3 | `fcf9033bd82d7bd214ddf418c8fffb370db51f49405bfbec55cb58cc6488727b` | `sha256:8dd227730b58faaede4368075aedc9f1164e0a2c527798eb4faa0f546a96a551` | 2026-09-24 23:33:31.427082789 |
| mini | `66d72c82fd4cb35cd8a56a6d6ed3376574d66eb8fab21843217ac4dfd95297cd` | `sha256:9087ff03bae75c99f8f4f5b4c2224a7d994495b79f40caf00fa2a05b60c0fca0` | 2026-09-24 23:33:30.560137508 |

Both containers' `/app` files below have the same SHA256 bytes as local `e5efc7c` **and** `fc0f972`. This binds the audited completion, retry, discovery, request-model and configuration code to files in the running gateway containers. It does not authenticate the complete source tree, loaded Python modules, package builds, upstream engine code, or an immutable deployment-to-source revision.

| File under `/app` | SHA256 in both running containers |
| --- | --- |
| `main.py` | `5f1a37976984c13c91eaca5e44c7782abb8f4a8ee2677bd7a332399b2ee7c2f3` |
| `app/routers/ollama_proxy.py` | `de7c44cdfdc36afc7a89026df6620c77d4c042b714f142e1c35b0f4dcf929752` |
| `app/services/vllm_client.py` | `8c528ad1259bd62382145c667d4ccdfe6fd073cea66419be538cfcd71e6bbe8e` |
| `app/services/mlx_discovery.py` | `d4511be8a7dc2625493400faacc02b0dbab68617c24280893e317e14d2eaef99` |
| `app/models/ollama.py` | `a2480eb96e9a6ae21f36dcfe4ee8690d7fad65e6f075f27d2ea2f6e31904097a` |
| `app/config.py` | `ec70ac4950398089732b944c2734fd8184a4bf94bdd78e424108b3d29ab9b2e7` |
| `app/services/mlx_concurrency.py` | `1f13a7640a280a966ef8cc9054784a8cef59067a8ad02b68cf1f8387572e993f` |
| `requirements.txt` | `3d6271468e624184f0692f7e4ad9903f0cef0857d2388bfd0d34d885baeb5a44` |

Allowlisted non-secret runtime environment reads showed the same M3 host/scan range, supa extra-server address and extra concurrency 64 in both containers. **`DEFAULT_NUM_CTX` differs: M3 8192, mini 32768.** This provides a concrete explanation for the earlier alternating advertised context metadata; it is not a measurement of engine enforcement. `MAX_CONTEXT_CHARS` was absent from both environments; the audited source default remains zero. No secret environment values were output.

### Current upstream metadata

From the running M3 gateway container, metadata-only `GET /v1/models` requests scanned its configured M3 ports and the configured supa endpoint. Only gpt-oss matches and supa model metadata were printed:

| Candidate route | Direct `/v1/models` observation | Version observation |
| --- | --- | --- |
| M3 port 8014 | `id:gpt-oss-120b`, `owned_by:mlx` | `/version` returned 404; OpenAPI is generic `FastAPI` version `0.1.0` |
| supa port 8000 | `id:Inferact/Qwen3.8-27B-NVFP4`, same `root`, `owned_by:vllm`, `max_model_len:32768`; a second `local-llm` alias points to the same root | `GET /version` returned `0.30.0`; OpenAPI is generic `FastAPI` version `0.1.0` |

These observations identify the current discovery candidates. They do not read the gateway's cached request resolution or supply a request-bound routing receipt, so alias collision/cache drift remains outside this proof. `owned_by:mlx` comes from this direct upstream response, whereas the gateway's hardcoded `backend:vllm` field remains unsuitable for engine identification.

M3's upstream OpenAPI exposes `/health` and `/v1/models` among the searched metadata/contract paths. Supa's exposes `/version`, `/health`, `/tokenize`, `/detokenize`, `/v1/models`, and `/v1/responses/{response_id}/cancel`. Only the OpenAPI document was read: no tokenize, response, or cancel operation was executed. A cancellation route for the Responses API does not prove cancellation or deadline semantics for this gateway's streaming Chat Completions request.

### Executed read-only command boundaries

The following Dokploy paths were requested for application IDs `shwPqEXAEoCrjIWH3zuKx` (M3) and `ViriMctSKONq8z1UZBCll` (mini):

```text
GET https://deploy.brut.bot/api/application.one?applicationId=<id>
GET https://deploy.brut.bot/api/deployment.all?applicationId=<id>
```

Authentication was captured in subprocess memory from macOS Keychain item `deploy.brut.bot` / `dokploy-api-key` and supplied through curl configuration on stdin. It was not included in process arguments or output. The executed Python request function was:

```python
def get(path):
    cfg = 'header = ' + json.dumps('x-api-key: ' + secret) + '\n'
    proc = subprocess.run(
        ['curl', '-fsS', '--connect-timeout', '10', '--max-time', '25',
         '--config', '-', 'https://deploy.brut.bot/api/' + path],
        input=cfg, text=True, capture_output=True)
    if proc.returncode:
        return {'read_error': proc.returncode}
    try:
        return json.loads(proc.stdout)
    except Exception:
        return {'read_error': 'invalid_json'}
```

The application output allowlist was `applicationId, appName, applicationStatus, sourceType, branch, repository, owner, serverId, autoDeploy, dockerBuildStage`. Deployment output was limited to IDs, status and timestamps; available field names were also inspected to establish that no commit-hash field existed. Historical helper `/tmp/abcllm_dokploy.py` and state `/tmp/abcllm-deploy-state-20260921.json` were absent. Existing client credential file `/Users/jr/.config/abcllm/config.json` was located but not opened for this follow-up.

The following SSH commands were executed. The remote accounts are operational connection identifiers, not credential material; no SSH keys or authentication values were inspected or recorded:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 jr@100.92.77.66 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH docker ps --filter name=app-reboot-optical-matrix-3bl2a4 --format "{{.ID}} {{.Names}} {{.Image}}"'
ssh -o BatchMode=yes -o ConnectTimeout=10 jr@100.116.119.93 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH docker ps --filter name=app-hack-optical-monitor-v1ioak --format "{{.ID}} {{.Names}} {{.Image}}"'
ssh -o BatchMode=yes -o ConnectTimeout=10 jr@100.92.77.66 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH docker inspect --format "{{.Id}} {{.Image}} {{.State.StartedAt}} {{.Config.WorkingDir}}" fcf9033bd82d'
ssh -o BatchMode=yes -o ConnectTimeout=10 jr@100.116.119.93 'PATH=/opt/homebrew/bin:/usr/local/bin:$PATH docker inspect --format "{{.Id}} {{.Image}} {{.State.StartedAt}} {{.Config.WorkingDir}}" 66d72c82fd4c'
```

File hashes used the same two SSH destinations and `docker exec -i <observed-container-id> python -`. The executed stdin payload used Python's standard library only, without importing the gateway application or triggering startup/cache/warmup code:

```python
import hashlib, json, os, pathlib, urllib.parse
files = ['main.py', 'app/routers/ollama_proxy.py',
         'app/services/vllm_client.py', 'app/services/mlx_discovery.py',
         'app/models/ollama.py', 'app/config.py',
         'app/services/mlx_concurrency.py', 'requirements.txt']
hashes = {p: hashlib.sha256(pathlib.Path('/app', p).read_bytes()).hexdigest()
          for p in files}
config = {}
for name in ['MLX_HOST', 'MLX_PORT_RANGE', 'MLX_EXTRA_SERVERS',
             'MLX_CONCURRENCY', 'MLX_EXTRA_CONCURRENCY',
             'MAX_CONTEXT_CHARS', 'DEFAULT_NUM_CTX', 'VLLM_BASE_URL']:
    value = os.environ.get(name)
    if value is not None:
        config[name] = ('redacted_credential_bearing_value'
                        if '@' in value else value)
print(json.dumps({'hashes': hashes, 'nonsecret_runtime_config': config}))
```

The local orchestration compared these hashes with local file bytes and `git show e5efc7c:backend/<path>` in memory; every comparison was true. It did not copy any remote files to disk.

Upstream reads used the same M3 `docker exec -i ... python -` boundary, `urllib.request`, three/four-second request timeouts and a bounded thread pool. The exact requested metadata paths were `/v1/models` on configured M3 ports `8001–8020,8050–8055,8060` and supa port 8000; `/version` and `/openapi.json` on M3 port 8014 and supa port 8000. Existing internal authentication, where required, stayed in memory. The model-output allowlist was `id,root,owned_by,max_model_len,parent`; OpenAPI output included only title/version and matching metadata/contract path names. No completion, model pull, preload, refresh, latency probe or test-chat endpoint was called. In particular, the source's **GET** `/api/admin/latency-probe` performs inference and was excluded.

### Admission decision after this readback

`unsupported_provider_budget` remains correct. Evidence improved for the audited gateway file bytes and current upstream discovery metadata, but the required contract is still missing:

1. **Full execution identity:** no authoritative complete gateway/build revision, M3 engine/build identity, weights revision, tokenizer revision, chat-template revision, or request-bound route receipt. Supa's version string alone does not identify its exact build/configuration.
2. **Hard total-token bound:** no enforcement proof covering prompt/template tokens, all visible/hidden reasoning tokens, every generated sequence and every upstream attempt; no oversize/no-silent-clipping proof. The exposed context values and caller `max_tokens` are insufficient.
3. **Fixed attempt policy:** the running-container file hashes confirm that the audited Qwen 400/422 option-removal retry code remains present. Its fallback changes thinking conditions; rejected-attempt cost and any engine/proxy retries remain unproved.
4. **Usage provenance:** the matching running completion code still permits synthetic character-estimated usage. No request-bound actual counter covering reasoning and all attempts was obtained.
5. **Remote completion/cancellation:** no acknowledged chat-request cancellation, total generation deadline or authoritative indeterminate-request resolution was established. A client abort cannot release reservations or permit a sealed/completed-run claim.

Keep the existing AI1/AI2 models and fail-closed replay admission. Provider remediation, deploying it, inference validation and the 30-minute baseline remain separate work; this read-only investigation did not perform or complete those steps. Other roadmap PRs can continue within their approved inactive boundaries.
