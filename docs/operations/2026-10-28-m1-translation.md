# M1 translation admission with an additive capacity policy

> 모델 설정 유연화 차선: 아래 모델 선택은 이 문서 작성 당시 기록이다. 새 코드의 제품 번역 기본값은 M1 Gemma 4 26B이며, 실제 운영 설정의 변경·readback 확인은 별도다. 설정·우선순위·계약·롤백은 [모델 레지스트리 절차](model-config-registry.md)를 따른다.

The existing product translation worker selects `[m1] qwen3.8-flash-next` through
`PRODUCT_TRANSLATION_MODEL`. abcLLM PR7 preserves the explicit server label when
GPU3090 offers the same model name. M1 relay authentication, IP restrictions,
one in-flight request, strict terminal handling, and translation quality checks
remain active. Korean tagline and review-reason translation keep their existing
model selection.

An indeterminate request remains charged to its original policy. A policy may
carry `compatiblePredecessor` with the exact predecessor epoch, revision, and
complete policy. This is accepted only when every existing route, bound, weight,
and TTL is unchanged and additional routes use new provider budgets and physical
groups. Each old active row must authenticate that predecessor using its own
policy hash. Different writer epochs, changed limits or routes, and unproven old
policies retain the generation barrier. Unknown requests are never rewritten,
released, or marked settled by this feature. Existing global/pool counts include
them when admitting work to the independent server.

Deploy compatible parsing to all capacity consumers before storing this optional
field. Use the existing audited DRAINING -> policy -> OPEN commands. This is not
a replacement for native recovery of an unknown request on its original server.
No DB migration or new DB account is required.

The product job receives a 55-second tick, matching the existing reason
translation budget. After admission and domain locks, it must still have the
full 20-second HTTP ceiling plus 2 seconds before marking a dispatch. Otherwise
it cancels the untouched reservation and defers; waiting must not cause an
immediately aborted model request.

M1 readback on 2026-10-28: oMLX 0.7.2, server source
`1aa9294eb56fd36a0b4bb71af308dc387f26aaa8f71eb3b31e4830a1e5ea0662`,
model settings `c1f4c84b5a65125082979cf64d03d2a286eea1f4c593848f28165701ab12e7b6`.
The model advertises and enforces a 32,768-token prompt limit. The product
translation wire explicitly limits generated tokens to at most 8,000, so this
route is conservatively charged 40,768 tokens. This does not claim that the
server enforces a combined 32,768-token sequence bound. The relay's direct-native
readiness flag remains separate from abcLLM strict-terminal admission.

Runtime completion requires actual M1 dispatch, an accepted strict terminal,
and quality-checked translations saved with the M1 model label. Installation,
configuration, or an OPEN control alone does not prove translation participation.
