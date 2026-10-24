# Uptime 호스팅 중단 안내 보류 검증 — 2026-10-24

## 실제 개발 평가에서 드러난 오류

근거 경로 계약 수정 통합 SHA `474f1306c4cba80f1ccc0504f6aa85db5d1a2c49`에서 원본 출처·입력·사전 라벨을 바꾸지 않은 새 계약 freeze로 실제 GPU 17건을 직렬 호출했다. 첫 1건의 HTTP/model/finish/usage/schema/guard를 확인한 뒤 나머지 16건을 진행했다. 이전 실패 1회를 합하면 실제 호출은 총 18회, 재시도 0, 동시 1이다. 출력 상한 2,048 tokens, C=50,000, 요청당 90초 제한을 유지했다.

이 평가는 고정 snapshot의 별도 bounded direct OpenAI 오프라인 평가다. production native admission·원장·정산 권한·freshness 통과·전역 readiness를 주장하지 않는다. 평가에서 운영 DB 접근·변경은 없었다. 출처와 Codex 독립 AI 라벨은 모델 전에 고정했지만, 이미 개발에 쓴 표본을 포함하므로 사람 독립 holdout도 아니다.

| 실제 17건 측정 | 결과 |
| --- | --- |
| JSON Schema 유효 | 17/17 |
| 당시 서버 guard 통과 | 16/17 |
| guard 통과 후 finding·fact가 사전 Codex 라벨과 일치 | 14/17 |
| 당시 guard를 통과한 잘못된 내림 제안 | 2건 |
| 원격 종료 불명 | 0건 |
| p50 / p95 | 2,117ms / 5,122ms |

두 잘못된 내림 제안의 현재 전체 본문은 HTTP 402의 `Payment required DEPLOYMENT_DISABLED`와 요청 추적 ID뿐이었다. 모델은 이를 `closed/explicit_shutdown`과 `delist_candidate`로 제안했다. 인용과 필드 경로는 원문에 맞아 당시 guard를 통과했지만, 호스팅 결제·배포 중단만으로 제품 영구 종료가 입증되지는 않는다. 실제 503 중단 안내 표본들은 보류했지만, 같은 위험을 재현하는 503 응답도 합성 회귀로 고정했다. 별도의 1건은 모델이 원문 인용을 바꿔 기존 `invalid_evidence_quote`로 거절됐다.

이 측정은 자동 적용 부적격이다. 사람 독립 라벨·새 프롬프트 실제 평가·배포 후 fresh native canary·전역 caller 준비가 충족됐다는 뜻이 아니다. parked·접근 차단·실제 HTTP 200 soft-404의 live coverage도 부족하다. 공개 저장소에 비공개 cohort와 원문을 넣지 않는다.

## 최소 guard와 프롬프트

`validateAssistOutcome`은 uptime의 `delist_candidate`에만 다음 현재 페이지 조합을 확인한다.

- source가 `complete`인 `page` 또는 `rendered_page`이며 URL이 요청 또는 최종 URL과 같다.
- HTTP 402이며 본문 전체가 `Payment required DEPLOYMENT_DISABLED`다.
- 또는 HTTP 503이며 본문 전체가 `The deployment is currently unavailable DEPLOYMENT_PAUSED`다.
- 안내 뒤의 단일 요청 추적 ID 형태는 선택적으로 허용한다. 앞뒤 공백 외의 다른 본문이 있으면 이 알려진 안내 화면 규칙에 일치하지 않는다.

일치하면 `uptime_hosting_notice_requires_review`를 반환한다. 소비자의 기존 invalid 결과 경로가 해당 work를 `human`으로 보내며 결과·제품 차단·내림 감사·CDN purge를 만들지 않는다. 실제 모델 응답을 수정하거나 `unclear`로 바꿔 저장하지 않는다. 프롬프트에는 호스팅 결제·중단 안내만 있는 경우 `unclear`와 추가 근거/사람 확인을 제안하라고 명시했다.

HTTP 402/503 자체를 일괄 차단하지 않는다. 명시적 영구 종료·요청 자원 없음과 본문 일부의 호스팅 오류 설명은 기존대로 검증한다. 인용의 대소문자·공백 등을 허용하는 정규화도 추가하지 않았다.

wire `schema_version`/`promptVersion`은 기존 `2026-10-23.1`, uptime 근거 경로 revision은 `2026-10-24.1`을 유지한다. 이번 수정은 같은 JSON Schema의 서버 의미 guard를 더 엄격하게 하고 uptime prompt만 바꾼다. 기존 큐의 wire 변환은 필요하지 않으며 기존 유효 종료·soft-404 응답의 허용 범위는 회귀로 확인했다. 다른 네 업무의 schema/prompt hash는 실제 비교에서 불변이다.

| 계약 | SHA-256 |
| --- | --- |
| 실제 17건 평가 dataset canonical hash | `912c84b157c0a42fc5d561c43cb41a8042152c1fbdf95383469188e76dafd0cc` |
| 유지한 uptime JSON Schema hash | `fafe8e354f66f4f2b1cad71a6f55d708e5a7ceaaaaed7d26240a4845d910352b` |
| 실제 17건 호출 당시 prompt hash | `7e99661ed5916000d22540bcc944c18746049122fe8afc1eb58cb498de500916` |
| 이번 호스팅 보류 prompt hash | `a9345c8892920d3d2af39bf576ce840559b7e5450f7a7c703b0e4ece78a7f83d` |

## 실행한 검사와 재현 범위

- 구현 전 새 unit 11건: guard 2건과 prompt 1건의 예상 assertion 실패로 RED, 나머지 8건 통과. 구현 뒤 같은 11건 GREEN.
- 구현 전 fake native 소비자 회귀 2건: work가 `done`이 되어 `human` 예상 assertion 실패. 구현 뒤 두 회귀 모두 GREEN, 나머지 21건은 이 targeted 실행에서 skip했다.
- 관련 unit 7파일 49건 PASS, 전용 DB에서 dispatch integration 파일 23건 PASS.
- `next typegen`, 전체 TypeScript, 변경 TS 4파일 ESLint, `git diff --check`: 실제 exit 0.
- 저장된 실제 17개 응답을 **새 guard에만** 재생: schema 17건, guard 14건 통과. 실제 잘못된 내림 2건은 새 hosting 오류로, 기존 인용 변형 1건은 같은 quote 오류로 거절됐다. 모델 추가 호출은 0이다. 이전 prompt의 출력을 새 prompt의 품질 측정으로 옮기지 않는다.

첫 격리 DB를 일반 PostgreSQL 17 이미지로 띄웠다가 migration이 vector extension 부재로 테스트 시작 전에 실패했다. 이는 RED assertion이 아니다. 해당 컨테이너를 멈추고 `pgvector/pgvector:0.8.6-pg17`의 별도 loopback 임의 포트 `32773`에서 migration과 위 검사를 실행했다. 상위 작업자의 `55447` DB는 사용하지 않았다. Vite의 기존 `configLoader` 경고는 남아 있다.

```sh
npx vitest run tests/uptime-hosting-notice.test.ts tests/llm-assist-contract.test.ts tests/llm-assist-evaluation.test.ts tests/uptime-assist-evidence.test.ts tests/llm-assist-capacity-binding.test.ts tests/local-model-serving-contract.test.ts tests/local-model-terminal.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32773/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/llm-assist-dispatch.test.ts
npx next typegen
npx tsc --noEmit --incremental false
npx eslint lib/domain/llm-assist/contracts.ts lib/domain/llm-assist/prompts.ts tests/uptime-hosting-notice.test.ts tests/integration/llm-assist-dispatch.test.ts
git diff --check
```

비공개 실제 요청·응답·hash·사전 라벨과 replay는 `/private/tmp/nomorevibe-llm-activation-20261024/evaluation/`에 디렉터리 0700/파일 0600으로 보존한다. `actual-gpu-offline-v3/evaluation-report.v3.json`이 실제 측정이고, `saved-actual-hosting-notice-guard-replay.json`은 새 모델 호출 없는 guard 재생이다. 실제 새 모델 호출과 운영 변경·배포는 이번 수정에서 하지 않았다. 통합 SHA의 필수 CI·배포·추가 실제 평가와 사람 라벨은 상위 작업자가 별도로 조율한다.
