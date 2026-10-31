# abcLLM 정리 — 다섯 env 읽기 제거 진행 (2026-10-31)

구역: abcLLM 게이트웨이 제거 뒤 남은 코드 의존 정리. 운영 명령·운영 DB·Dokploy·env 변경은 이 구역이 하지 않는다(대표가 배포 뒤 한다).

## 끝낸 것 (PR #758)

- 텍스트 경로 판정: `textRouteBlock`/`textRouteCallable`(lib/llm/serving-contract-store.ts)이 직접 연결 계약(관리자, transport direct,
  인증 none 또는 저장 키)만 본다. 게이트웨이 키 대체 분기 삭제. 이유 코드 `no_direct_contract`·`gateway_auth`·`stored_key_unreadable`.
- 여섯 text 잡(사유 번역·소개 짓기·검색 키워드 짓기·검수·한국어 소개·제품 번역)이 키 대신 위 판정으로 접는다(degraded 코드 = 이유 코드).
- text-progress: 키 확인 대신 직접 계약이 없는 경로의 대기열을 멈춤 판정에서 뺀다(단계 풀 선택 이름 포함).
- 옛 게이트웨이 송신(writeKeywords·verifyKeywords·writeTagline·번역 chat)은 보내지 않고 `no_key` 로 끝난다.
- AI1/AI2 `contractBearer`: abcllm 계약은 직접 연결 행의 키 없음/저장 키만. 게이트웨이 키·게이트웨이 전송 행은 거절.
- `reviewWithGateway` 기본 게이트웨이 주소 삭제, `listGatewayModels` → `listReviewEngineModels`(직접 계약이 켜진 심사 모델, 네트워크 없음).
- `ABCLLM_SERVING_CONTRACTS` 시작 계약 삭제 — 계약은 `model_serving_contracts` 행만. 관리 화면의 「env 계약」 칸 삭제.
- `ABCLLM_TAGLINE_MODEL`·`PRODUCT_TRANSLATION_MODEL`(과 `_KEY`): `MODEL_PURPOSE_ENV` 값 null — 등록부·관리자 덮어쓰기·단계 풀이 정한다.
  상수 `PRODUCT_TRANSLATION_MODEL` → `PRODUCT_TRANSLATE_MODEL`.
- `CRAWL_REVIEW_MODEL`: 1차 심사자는 관리자 설정 `firstReview` 만. `reviewModel()` → `cliReviewModel(value)`(이름 검사만).
- 설정 파일 정리: `.env.example`, `compose.yml`(reviewer·text), README, PENDING, 운영 env 예시, runbook·모델 문서.
- rev13 정책 초안: `docs/operations/2026-10-31-capacity-policy-rev13-draft.json`(+ `.md`, 운영 적용 안 함).

- 시험: 단위 8,583/8,583, 통합(자기 Postgres) CI 실패 28개 파일 + 새 DB 전용 8개 파일 통과. PR #758 CI 전부 통과(7a538b2d).

## 남은 것 (대표·후속)

- 배포 뒤 18앱에서 다섯 env 삭제 — 확인 순서는 PR #758 설명 "지우기 전에 대표가 확인할 것".
- rev13 초안의 "확인 필요" 15곳 확정 → DRAIN → 정책 → 장비 행 → OPEN dry-run(`device_unconfigured` 없음) → OPEN.
- 다섯 밖 남은 게이트웨이 흔적: `ABCLLM_BASE_URL`(abcllm 등록부 주소 덮어쓰기), `ABCLLM_MODEL`, 코드 기본 등록부의 `gatewayLabel`·abcllm-api 주소,
  번역 strict-terminal 헤더, 죽은 코드 `text-capacity-admission.ts`·`verifyKeywordsInChunks` 재시도 본문, 관리자 공급자 이름 "사내 게이트웨이".
- capacity `disabled` 모드에서 직접 계약이 있는 text 잡은 옛 경로가 `no_key` 실패 행을 남긴다(이 PR 전에도 `direct_engine_contract_only` 로 같았다) — 잡을 degraded 로 접는 편이 낫다.
- fixed-input replay 의 legacy abcllm 모드는 이제 보낼 수 없는데 사전 점검이 받아 준다 — 거절하도록.
- Oracle 번역 canary 는 native 번역 틱이 성공해야 인증된다(no_key 틱은 결과를 인증하지 않는다).

## 막힌 것

- 없음. 관리자 화면 문구 변경은 로그인·DB 가 필요해 앱을 띄워 눌러 보지 못했다(컴포넌트 시험으로만 확인).
