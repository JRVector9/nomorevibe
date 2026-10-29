# 모델 연결 관리 화면 (배포 없이 모델 주소·인증 바꾸기)

모델을 **어디로**(주소) **어떻게**(응답 모델, 토큰 한도, 인증) 부르는지의 계약과 모델 등록부 정의를 관리 화면 `/admin/models/contracts`(「모델 연결」)에서 저장한다. 저장하면 각 앱이 **30초 안에, 다음 작업부터** 쓴다. 재배포는 필요 없다(JR 지시 2026-10-29: "env에 모델을 고정하지 말고 관리자에서 바꾸게").

## 무엇이 어디에 있나

| 항목 | 위치 | 바꾸려면 |
| --- | --- | --- |
| 1차·2차·단계별 모델 선택 | DB (`/admin/models`) | 관리 화면. 배포 없음 |
| **서빙 계약**: 게이트웨이 9개 경로(1차, 2차 게이트웨이, 번역, 소개, 검색) | DB `model_serving_contracts`(0147) 위에 env `ABCLLM_SERVING_CONTRACTS` | 관리 화면. 배포 없음 |
| **모델 등록부 정의**(장비, 주소, 엔진 모델명, abcLLM 이름표, 제한 시간·토큰) | DB `model_registry_overrides`(0148) 위에 코드 기본값 | 관리 화면. 배포 없음 |
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

## 엔진 연결 (주소·키·모델만 넣기, 0148)

화면 맨 위 「엔진 연결」은 OpenAI 호환 엔진 하나를 등록부 모델 하나에 붙인다. 한 번 저장으로 아래를 같이 한다.

1. 서버가 그 주소의 `/models`를 다시 읽는다. 고른 모델이 목록에 있어야 하고, 그 최대 길이가 계약의 토큰 한도(`totalTokenBound`)가 된다. 키는 이 한 번의 요청에만 쓴다.
2. 고른 등록부 정의(예: `m1:translation`)의 주소와 엔진 모델명을 바꾸고 abcLLM 이름표(`[m1]`)를 뗀다. 엔진은 자기 모델명만 받기 때문이다(이름표가 붙으면 404).
3. 고른 경로마다 엔진 직접 계약을 만든다. 전송 방식은 `direct`, 인증은 저장 키(또는 키 없음)다. 번역 4경로에는 엄격 종료 표시를 붙인다.
4. (선택) 고른 경로의 단계별 모델을 이 등록부 키로 지정한다. 단계 선택이 없으면 잡은 시작 때 읽은 코드 기본 모델명을 쓰므로 이 지정이 필요하다.
5. 용량 정책에 `경로 / abcllm / 엔진 모델명`이 없으면 결과에 알려 준다. 그 호출은 정책을 추가할 때까지 보류된다(미확인 요청은 생기지 않는다).

- 등록부·계약 저장은 한 트랜잭션이다. 단계 지정은 그 뒤의 일반 설정 저장이다.
- 키를 비워 두면 같은 경로·엔진 모델에 저장된 키를 다시 쓴다.
- 「모델 등록부 덮어쓰기」에서 정의를 JSON으로 직접 고치거나 되돌릴 수 있다. 저장할 때 합친 등록부 검사, 한 용도에 한 모델, 저장된 단계 선택과의 일치를 확인한다.

### 직접 전송(`transport direct`)이 바꾸는 것

- abcLLM이 붙이는 `usage_provenance`가 없어도 엔진의 완결 응답을 정상 종료로 본다. 엔진이 알려 준 토큰 사용량(입력+출력=합, 한도 이하)을 그대로 센다.
- 게이트웨이 계약(기본값)은 이전과 같다. `usage_provenance`가 없는 응답은 종료가 아니다.
- 옛 번역 경로(용량 제어가 꺼졌을 때만 쓰는 경로)는 직접 연결 모델을 부르지 않는다. 그 경로는 abcLLM 키를 보내기 때문이다.

### Tailscale 이름(`*.ts.net`)

- 컨테이너(OrbStack)의 DNS는 tailnet 이름을 모른다. 그래서 워커와 웹은 시작할 때 전역 HTTP 연결기에 이름 풀이 보완을 넣는다. 시스템 DNS가 먼저이고, 실패하면 `*.ts.net`만 Tailscale DNS(100.100.100.100)에 묻는다.
- TLS 인증서는 그대로 호스트 이름으로 검증한다. 다른 이름은 바뀌지 않는다.
- 2026-10-29 운영 crawler 컨테이너(Node 24)에서 확인했다. 그대로는 `ENOTFOUND`였고, 보완을 넣으니 M1 `/v1/models`가 401(키 필요)을 돌려줬다. 게이트웨이는 200 그대로였다.

## 예: M1 Gemma 번역을 엔진에 직접 연결

1. 「엔진 연결」에서 아래처럼 넣고 저장한다.
   - 등록부 모델: `m1:translation`
   - 주소: M1 주소(`https://…ts.net/v1`)
   - 인증: API 키 저장
   - 「엔진 확인」 후 엔진 모델: `mlx-community--gemma-4-26b-a4b-it-4bit`(최대 98304)
   - 경로: `product-translate`, `reason-translate`
   - 단계 지정: 켬
2. 용량 정책에서 두 경로의 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`를 `mlx-community--gemma-4-26b-a4b-it-4bit`(그룹 `m1-qwen`)로 바꾼다. DRAIN → 정책 → OPEN 순서다.
3. `product-translate` 일시 중지를 푼다.

## 예: 1차에 gpu3090 qwen 직접 연결 (abcLLM 거치지 않음)

1. `/admin/models/contracts`의 「계약 추가·수정」에서 경로 `crawl-agent-review`를 고른다. 「엔진 확인」으로 `qwen3.8-flash-next`와 최대 50000을 읽고, 아래 계약을 저장한다(전송 `direct`, 인증 `none`). gpu3090 등록부 정의는 직접 연결형(local-direct)이라 「엔진 연결」 대상이 아니다.
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

- 이 기능 자체는 새 코드라 한 번 배포해야 한다. 0147·0148 적용과 웹·워커 새 이미지가 필요하다. 그 뒤의 계약·등록부 변경은 배포 없이 관리 화면에서 한다.
- 0147은 테이블 하나를 만든다. 0148은 그 테이블에 기본값이 있는 `transport` 열을 더하고 등록부 덮어쓰기 테이블을 만든다. 기존 행과 제약은 건드리지 않는다.
- 저장 키를 쓰려면 웹·워커에 `NMV_SECRET_BOX_KEY`가 있어야 한다.
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
- 엔진 연결(2026-10-29):
  - 단위 `tests/engine-connect.test.ts` 6건: Tailscale 이름 풀이 순서·실패, 전역 연결기 한 번 설치(Node 22·24 모두), 등록부 덮어쓰기 합치기·잘못된 행 닫기·env 우선, 저장 검사(용도 중복·단계 선택 불일치), 주소 정리
  - `tests/gateway-strict-terminal-header.test.ts`에 2건: 번역 4경로에서 직접 계약은 `usage_provenance` 없이 종료·사용량 계산·저장 키 전송, 게이트웨이 계약은 그대로 거절. 옛 경로는 직접 연결 모델을 부르지 않음
  - 통합(PG17) 1건: 한 번 저장으로 등록부·직접 계약 2개·단계 지정, 키 비노출, 다시 읽으면 엔진 모델명·키·직접 전송, 키 없이 다시 연결하면 저장 키 재사용, 되돌리면 코드 기본값
