# Uptime 근거 필드 경로 계약 검증 — 2026-10-24

## 실제 관측과 실패

실제 GPU 모델 호출 전에 공개 GET 출처·원문·시각·hash와 Codex 독립 라벨 27건을 고정했다. 당시 consumer가 모델에 보낼 수 있는 complete/nonempty 본문은 17건, 본문 미확보로 모델을 호출하지 않는 표본은 10건이었다. 라벨은 `codex_independent_pre_model`이며 `human_independent`가 아니다. 편의 표본이고 parked·접근 차단·실제 HTTP 200 soft-404는 미확보했다.

고정 본문은 production의 3분 freshness admission을 이미 넘겼다. 출처 시각을 고치거나 도메인 guard를 우회하지 않고, 승인된 별도 bounded direct OpenAI 오프라인 품질 평가로 첫 1건만 호출했다. 실제 production native dispatch·원장·전역 readiness를 통과했다는 뜻이 아니다. 운영 DB·제품·제어·역할 lease는 이 평가에서 읽거나 쓰지 않았다.

GPU 실제 readback의 C=50,000, max-num-seqs=6을 사용해 동시 1, 최대 17회, 출력 2,048 tokens, 요청당 90초, 재시도 0으로 제한했다. 첫 응답은 HTTP 200, 응답 model `qwen3.8-flash-next`, finish `stop`, 1,077 input + 236 output = 1,313 tokens, reasoning tokens 0, 3,442ms였다. 종료 상태는 closed/explicit_shutdown이었지만 근거 `supports`를 `/state/closed`로 써 서버가 `invalid_evidence_pointer`로 거절했다. JSON Schema 구조는 통과했으나 실제 필드 경로가 아니었다.

이 실패 뒤 즉시 중단했다. 실제 호출은 총 1회, 나머지 16건 미실행, 원격 종료 불명 0이다. 출력 내용을 고치거나 재시도하지 않았다. 17건 정확도·운영 오류율·자동 적용 적격성을 주장하지 않는다.

비공개 원본은 git 밖 `/private/tmp/nomorevibe-llm-activation-20261024/evaluation/`의 0700/0600 산출물에 보존했다. 공개 저장소에는 cohort·원문·운영 키를 넣지 않는다.

| 산출물 | SHA-256 |
| --- | --- |
| 첫 요청 wire | `f7b69a339af652349b2b670daa89823ca51ba97ea86132c3df84a5d6ef9b5e96` |
| 첫 응답 body | `404419f82adcb75617608f54a8dd080ff1eb03c2ce584e858796b69cfbdd162c` |
| 고정 17건+backend 평가 dataset의 canonical hash | `71da32ec53f20889cd74d070fdc491477628f03d32254de161368f84f239e240` |

## 최소 수정과 호환성

uptime outcome의 `evidence.supports`만 `/state/page_state`, `/state/finding` enum으로 제한했다. 프롬프트는 `page_state: closed`의 값과 `/state/page_state` 필드 경로를 구분하는 예시를 추가한다. 잘못된 모델 출력을 자동 교정하지 않는다. 기존 인용·필드 존재·기권·내림·관리자 보호 guard도 유지한다.

wire `schema_version`/`promptVersion`은 `2026-10-23.1`을 유지하고 uptime 경로 계약 revision `2026-10-24.1`을 별도로 명시한다. 기존 strict uptime state에는 두 필드만 있었으므로 새 enum이 제외하는 경로는 기존 필드 존재 guard도 이미 거절하던 값이다. 기존의 두 정상 경로는 계속 통과한다. 잘못된 값의 거절 지점은 runtime pointer guard에서 schema parse로 앞당겨지며 consumer는 계속 사람 확인으로 보낸다.

공통 wire 상수를 올리면 다른 업무와 기존 큐의 버전·source unique 키 재등록까지 영향이 간다. 이번에는 그 마이그레이션을 만들지 않는다. 다른 네 업무의 JSON Schema·prompt hash가 바뀌지 않았음을 실제 비교했다.

| uptime 계약 | 수정 전 | 수정 후 |
| --- | --- | --- |
| JSON Schema canonical hash | `dad522fd6b591044b6f04a57652abfb2d441d8196383a81a03ffa92d060d2353` | `fafe8e354f66f4f2b1cad71a6f55d708e5a7ceaaaaed7d26240a4845d910352b` |
| prompt hash | `93184d430b610ab555f3a584854933ba92d8cbdba45f06d4d8bbd0edb13cd4bc` | `7e99661ed5916000d22540bcc944c18746049122fe8afc1eb58cb498de500916` |

## 실행한 검사

- 수정 전 `npx vitest run tests/llm-assist-contract.test.ts`: 15건 중 새 회귀 2건 RED. `/state/closed`의 구조 통과와 새 경로 안내 부재를 확인했다.
- 최소 구현 뒤 같은 명령: 15건 GREEN.
- 아래 관련 회귀: 6파일 38건 PASS. DB·모델을 사용하지 않는 검사다.
- `npx next typegen`, `npx tsc --noEmit --incremental false`, 변경 TS 3파일 ESLint: 실제 exit 0.
- 최초 새 WT의 tsc는 생성 route type이 없어 `PageProps` 8개 오류로 실패했다. `next typegen` 뒤 같은 tsc가 통과했다. 기존 Vite `configLoader` 경고는 남아 있다.

```sh
npx vitest run tests/llm-assist-contract.test.ts tests/llm-assist-evaluation.test.ts tests/uptime-assist-evidence.test.ts tests/llm-assist-capacity-binding.test.ts tests/local-model-serving-contract.test.ts tests/local-model-terminal.test.ts
npx next typegen
npx tsc --noEmit --incremental false
npx eslint lib/domain/llm-assist/contracts.ts lib/domain/llm-assist/prompts.ts tests/llm-assist-contract.test.ts
git diff --check
```

전체 unit·전체 DB·build·GitHub 필수 CI는 이 좁은 수정에서 재실행하지 않았다. 배포·실제 모델 추가 호출도 하지 않았다.

## 남은 검증

수정 통합 SHA에서 관련 회귀와 필수 CI를 확인한다. 다음 실제 비교는 새 schema/prompt hash를 고정한 별도 실행으로 기록하고, 이전 실패 결과를 새 계약 통과로 옮기지 않는다. 첫 실패 표본은 이미 모델 출력을 본 개발 회귀 표본이므로 보지 않은 holdout으로 다시 세지 않는다. 사람 독립 라벨·실제 비교·production fresh native canary·전역 caller 준비는 각각 별도로 충족해야 한다.

현재 consumer는 collection과 model에 같은 최대 90초 signal을 전달한다. collector가 60초를 쓰면 모델에 약 30초가 남는다. 정상 예산 내에는 3분 freshness보다 짧지만 DB 잠금 대기가 길어지면 dispatch/apply가 거절된다. apply가 거절된 delist 후보를 done으로 마치는 기존 동작은 운영 상태·재수집 표현의 별도 검토사항이며 이번 포인터 수정에 섞지 않았다.
