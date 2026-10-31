# abcLLM 정리 — 다섯 env 읽기 제거 진행 (2026-10-31)

구역: abcLLM 게이트웨이 제거 뒤 남은 코드 의존 정리. 운영 명령·운영 DB·Dokploy·env 변경은 이 구역이 하지 않는다(대표가 배포 뒤 한다).

## 끝낸 것

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

## 남은 것

- 시험 수정·PR·CI — 이 파일의 마지막 갱신에서 결과를 적는다.

## 막힌 것

- 없음(운영 env 삭제·rev13 적용·장비 행 저장은 대표 몫이라 이 구역 밖).
