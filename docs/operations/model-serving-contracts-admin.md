# 서빙 계약 관리 화면 (배포 없이 모델 주소·인증 바꾸기)

모델을 **어디로**(주소) **어떻게**(응답 모델, 토큰 한도, 인증) 부르는지의 계약을 관리 화면 `/admin/models/contracts`에서 저장한다. 저장하면 각 앱이 **30초 안에, 다음 작업부터** 쓴다. 재배포는 필요 없다(JR 지시 2026-10-29: "env에 모델을 고정하지 말고 관리자에서 바꾸게").

## 무엇이 어디에 있나

| 항목 | 위치 | 바꾸려면 |
| --- | --- | --- |
| 1차·2차·단계별 모델 선택 | DB (`/admin/models`) | 관리 화면. 배포 없음 |
| **서빙 계약**: 게이트웨이 9개 경로(1차, 2차 게이트웨이, 번역, 소개, 검색) | DB `model_serving_contracts`(0147) 위에 env `ABCLLM_SERVING_CONTRACTS` | 관리 화면. 배포 없음 |
| 용량 경로·한도 | DB 정책 | 지금은 `pipeline-control capacity policy`(DRAIN 필요). 관리 화면은 다음 작업이다 |
| AI2 직접·local·CLI 계약 | env | 다음 작업이다 |

- 켜진 DB 행은 같은 경로·모델의 env 계약을 대신한다. 끄면 env 계약이 다시 쓰인다.
- DB 행이 그 경로의 계약 형식에 맞지 않으면 **그 모델만 닫는다**(호출 보류). env로 되돌아가지 않는다.
- 저장할 때 같은 경로·모델의 이전 행은 비활성 이력으로 남는다. 감사 기록 `model-serving-contract-save`/`-disable`에 해시, 주소, 인증 방식을 남기고 키는 남기지 않는다.
- 앱은 잡을 시작하기 전에 계약을 다시 읽는다. 그 밖의 호출은 30초마다 백그라운드에서 다시 읽는다. DB 읽기가 실패하면 마지막 값을 계속 쓴다.
  - 되돌림 스위치: env `MODEL_SERVING_CONTRACTS_DB=0`이면 env 계약만 쓴다.
- `pipeline-control`(status, OPEN 판정)도 판정 전에 DB 계약을 읽는다. 그 프로세스의 `DATABASE_URL`을 쓰고, 없으면 env 계약만 쓴다.

## 인증

| 방식 | 보내는 키 |
| --- | --- |
| `gateway`(기본) | abcLLM 게이트웨이 키 `ABCLLM_API_KEY`. 직접 연결(local-direct) 계약이면 키 없음(이전과 같음) |
| `none` | 키를 보내지 않는다(키 없는 직접 연결 서버) |
| `stored` | 이 연결에 저장한 키 |

- 저장 키는 AES-256-GCM으로 암호화해 DB에 둔다.
- 암호화 키는 env `NMV_SECRET_BOX_KEY` 하나다. 32바이트 base64이고, `openssl rand -base64 32`로 만든다. 모델 설정이 아닌 인프라 비밀 값이며, 키를 쓰는 앱(웹·워커)에 같은 값을 둔다.
- 이 값이 없으면 저장 키 방식은 저장하지 못한다. 이미 저장된 키는 열리지 않아서 그 계약은 호출을 거절한다.
- 암호문은 경로·모델에 묶여 있어서, 다른 행으로 옮기면 열리지 않는다. 관리 화면은 키를 다시 보여 주지 않는다. 비워 두면 저장된 키를 유지한다.
- 적용 범위: `agent-review-gateway.ts`의 1차, 2차, 텍스트 경로 모두.

## 예: 1차에 gpu3090 qwen 직접 연결 (abcLLM 거치지 않음)

1. `/admin/models/contracts`에서 경로 `crawl-agent-review`를 고른다. 「엔진 확인」으로 `qwen3.8-flash-next`와 최대 50000을 읽고, 아래 계약을 저장한다(인증 `none`).
   ```json
   {"version":1,"protocol":"abcllm-raw-total-bound-v1","routeId":"crawl-agent-review","provider":"abcllm",
    "model":"qwen3.8-flash-next","responseModel":"qwen3.8-flash-next",
    "deploymentRevision":"gpu3090-vllm0.28.1rc1.dev388+g8a728663c-qwen3.8-flash-next-C50000",
    "endpoint":"http://100.77.43.63:8090/v1/chat/completions","totalTokenBound":50000}
   ```
   - 1차 어댑터는 계약의 `endpoint`로 바로 보낸다. 요청 본문의 `model`은 계약의 `model`과 같아야 하므로, vLLM이 쓰는 이름(`qwen3.8-flash-next`)을 그대로 쓴다.
2. 용량 정책에 경로 `crawl-agent-review / abcllm / qwen3.8-flash-next`(그룹 `gpu3090-qwen`)를 추가한다. 지금은 DRAIN → 정책 → OPEN 순서로 한다.
3. `/admin/models`에서 1차 추가 모델로 `abcllm / qwen3.8-flash-next`를 고른다. 2차에는 Supa(`[supa] Qwen3.8-27B-NVFP4`)를 더한다.
   - 1차와 같은 모델의 2차 표는 독립 표가 아니다. 그래서 qwen이 1차로 본 건은 Supa가, Supa가 1차로 본 건은 qwen이 2차를 본다.

## 첫 반영 (한 번만 배포 필요)

- 이 기능 자체는 새 코드라 한 번 배포해야 한다. 0147 적용과 웹·워커 새 이미지가 필요하다. 그 뒤의 계약 변경은 배포 없이 관리 화면에서 한다.
- 0147은 테이블 하나만 만든다. 기존 행과 제약은 건드리지 않는다.
- 배포 전까지는 env 계약만 쓰이므로 동작이 바뀌지 않는다.

## 검증 (작업자, 2026-10-29)

- 단위 `tests/serving-contract-store.test.ts` 5건:
  - 암호화 왕복, 다른 행 AAD, 키 없음
  - env 위 DB 덮어쓰기, 잘못된 행은 그 모델만 닫기, 끄면 env 복귀
  - 다른 경로·모델 행 거절
  - 인증 결정
- 통합 `tests/integration/admin-serving-contracts.test.ts` 4건(PG17):
  - 저장 시 이전 행 이력, 키는 암호문만 저장, 감사에 키 없음, 빈 키는 유지
  - 형식이 틀린 계약 거절, DB 제약(identity·auth·hash) 확인
  - 다시 읽으면 복호화된 키가 쓰이고, 끄면 사라짐
- 전체 단위 시험과 관례 시험(PageStamp, web gate, 13px) 통과. `tsc --noEmit` 0, ESLint 0.
