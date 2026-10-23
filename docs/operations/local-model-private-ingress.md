# M1 Qwen 사설 모델 호출 경로

M1의 oMLX는 `127.0.0.1:8000`을 유지한다. 이 relay는 별도 서비스 계정으로 실행하며 Tailscale IPv4 한 주소에서만 M3·mini의 허용된 IP와 별도 Bearer 키를 받는다. 화면 renderer의8791 경로와 독립적이다. 모델을 설치·교체하거나 oMLX를 외부 주소에 바인딩하지 않는다.

상태: **코드·가짜 upstream 검증용 설치물**. 실제 M1 설치, worker 컨테이너 접근, 모델 canary, 공통 capacity 연동·활성화는 별도 승인된 운영 단계다. 파일이 존재하거나 `relayReady`가 참이라는 사실만으로 M1 분산 도입 완료로 표시하지 않는다.

## 노출 경로

| 경로 | 동작 |
|---|---|
| `POST /v1/chat/completions` | 고정된 M1 Qwen 모델의 JSON 요청을 loopback에 전달한다. 추론은 한 번에1건이며 대기 요청을 relay 안에 쌓지 않는다. |
| `GET /v1/models` | loopback의 모델 목록을 전달한다. 모델 추론을 새로 실행하지 않는다. |
| `GET /v1/health` | relay generation·revision, busy·draining·indeterminate와 native 준비 여부를 반환한다. 모델 건강 검사를 대신하지 않는다. |
| `GET /v1/requests/<UUID>` | 인증된 요청 ID별 HTTP 관측 receipt를 반환한다. 입력·생성 본문·비밀키는 저장하지 않는다. |

모든 경로는 소켓의 실제 원격 IP와 relay 키를 확인한다. `X-Forwarded-For`·`Host`로 허용 IP를 바꿀 수 없다. query·관리 경로·임의 upstream URL·다른 모델·다중 생성 `n>1`은 거절한다. 요청 본문은 최대8MiB, 업로드30초, upstream 연결은 최대90초다. 워커의 기존 더 짧은 예산을 늘리지 않는다.

upstream Bearer 키는 M1에서만 읽으며, worker가 쓰는 relay 키와 다르다. 요청·응답 본문과 Authorization은 로그에 남기지 않는다. 응답의 model·finish_reason·usage와 SSE 바이트는 변경하지 않고, upstream의 쿠키 같은 불필요한 응답 헤더는 전달하지 않는다.

## 연결 종료와 receipt

worker는 전송 전에 `x-nmv-relay-request-id`에 소문자 UUID를 정해 넣는다. ID가 없으면 relay가 만들고 같은 응답 헤더에 싣지만, 연결 분실 뒤 조회가 필요한 capacity 호출은 반드시 클라이언트가 먼저 정해야 한다. 이미 기록된 ID는 재전송하지 않고 receipt를 조회한다. 완료된 ID 재전송은409, 다른 추론이 실행 중인 새 요청은429다. 같은 ID도 실행 중이면429가 먼저 반환될 수 있으며, 이것을 원래 요청이 시작되지 않았다는 증거로 사용하지 않는다.

receipt의 주요 필드는 다음과 같다.

- `requestId`, 실제 요청 bytes의 SHA256 `requestHash`, `requestModel`
- `relayGeneration`, relay 코드 `relayRevision`, 검증된 모델 배포 판과 맞춰야 하는 `deploymentRevision`
- `state`: `in_flight`, `response_complete`, `indeterminate`
- 실제 읽은 `upstreamStatus`, `responseHash`, `responseBytes`, 시작·종료 시각
- 관측한 `models`, `finishReasons`, `usage`, SSE `[DONE]` 여부와 파서 완전성

클라이언트가 끊겨도 upstream을 즉시 취소하지 않고 끝까지 읽는다. 이 동안 추론 자리는 계속 사용 중이다. upstream의 정상 HTTP 종료 후 receipt를 저장한다. 부분 EOF·연결 실패·90초 timeout은 모델 종료를 뜻하지 않으므로 `indeterminate`와 `active.json`을 남기고 새 추론을503으로 거절한다. relay를 재시작해도 남은 active 표시는 그대로 차단한다.

**receipt는 HTTP 관측이며 capacity의 native terminal이 아니다.** `response_complete`만으로 모델 슬롯을 해제하지 않는다. PR02의 adapter가 실제 serving 계약·request/body hash·owner/domain/binding·model/finish/usage를 검증해 발급한 불투명 terminal만 정산에 쓴다. response-only 계약의 client abort는 receipt가 나중에 생겼다는 이유만으로 원격 종료 증명으로 승격하지 않는다.

`createLocalModelRelay`의 `verifyNativeReadiness(context)`가 검증된 계약과 실제 관측을 연결하는 확장점이다. 단순 설정 boolean은 없다. hook 없는 기본 entry는 `nativeCapacityReady=false`다. hook을 연결해도 실제 응답의 model·finish_reason·usage 관측이 없거나 generation/배포 판이 불명확하면 준비됐다고 표시하지 않는다. 현 설치물이 PR02의 최종 검증을 대신하지 않는다.

## 승인 전 계획 확인

Node24 이상이 필요하다. 다음 `plan`은 설치·바인딩·모델 요청을 실행하지 않는다. IP·파일 경로는 실제 값으로 치환한다.8792는 제안 포트이며 설치 전 충돌을 확인한다.18008은 모델 프록시로 추측해 사용하지 않는다.

```bash
NODE_BIN=/opt/homebrew/bin/node bash scripts/ops/local-model-relay.sh plan \
  --sha <검토된-main-40자-SHA> \
  --host <M1-Tailscale-IPv4> \
  --allow-from <M3-Tailscale-IPv4>,<mini-Tailscale-IPv4> \
  --upstream-key-file <M1-oMLX-key-절대경로> \
  --deployment-revision <확인한-모델-배포판>
```

## 승인 후 설치와 worker 연결

`install`은 root 소유 `/usr/local/nmv-llm-relay/releases/<sha>`에 고정 릴리스를 받고, 로그인 없는 `_nmvllm` 계정과 `bot.brut.nmv-llm-relay` LaunchDaemon을 만든다. 별도 relay 토큰과 upstream 키 복사본은 `/var/nmvllm` 아래0400으로 보관한다. 키 값은 출력하지 않는다. 기존 renderer·oMLX의 사용자·설정·키 파일은 수정하지 않는다.

```bash
sudo NODE_BIN=/opt/homebrew/bin/node bash scripts/ops/local-model-relay.sh install \
  --sha <검토된-main-40자-SHA> \
  --host <M1-Tailscale-IPv4> \
  --allow-from <M3-Tailscale-IPv4>,<mini-Tailscale-IPv4> \
  --upstream-key-file <M1-oMLX-key-절대경로> \
  --deployment-revision <확인한-모델-배포판>

sudo bash scripts/ops/local-model-relay.sh status
```

설치 후 M3 주·mini **실제 worker 컨테이너**에서 인증 실패·models·health와 제한된 모델 canary를 확인한다. M1 모델은 `qwen3.8-flash-next`로 고정하고 다른 미상주 모델을 시험하지 않는다. macOS 방화벽 때문에 컨테이너에서 닿지 않으면 실제 Node 경로·Tailscale ACL·허용 IP를 확인하고, 방화벽 변경은 운영 실행 계획에 별도로 기록한다. relay가 임의로 방화벽을 해제하지 않는다.

worker의 endpoint/relay 키와 local serving 계약을 PR02 경로에 등록한다. 실제 M1을 쓰는 모든 화면·텍스트 호출이 같은 물리1슬롯에 들어가고, 직접 loopback을 호출하는 미계량 작업이 없는지 확인한다. 모델 API 접근 성공과 공통 native 정산 준비 완료는 별도 항목이다. 전역 capacity를 켜는 과정에서 기존 미연결 번역·검색을 멈추게 하지 않는다.

## 중단과 업그레이드

새 M1 admission을 먼저 중단하고 진행 중 모델 호출을 정상 drain·정산한다. `active.json`이 남으면 원격 실행이 끝났다고 추측해 삭제하거나 새 relay를 시작하지 않는다. 프로세스의 SIGTERM은 새 요청을 멈추고 upstream drain을 기다린다. 강제 종료·timeout 뒤의 불명 상태는 공통 capacity와 함께 보존한다.

```bash
sudo bash scripts/ops/local-model-relay.sh stop
sudo NODE_BIN=/opt/homebrew/bin/node bash scripts/ops/local-model-relay.sh upgrade \
  --sha <새로-검토된-main-40자-SHA> \
  --deployment-revision <확인한-모델-배포판>
```

키와 receipt를 유지한 채 같은 절차로 이전의 호환 SHA를 지정하면 설치물 판을 되돌릴 수 있다. 모델 자체를 롤백하지 않는다. `uninstall`은 LaunchDaemon 등록만 제거하고 키·receipt·릴리스·서비스 계정은 보존한다. 원격 종료 불명 기록의 해제는 PR02의 증거 정산·운영 검토 뒤 별도 수행하며, 이 설치물에는 임의 `clear unknown` 기능이 없다.

```bash
sudo bash scripts/ops/local-model-relay.sh uninstall
```

receipt에는 자동 보존기간 삭제를 적용하지 않는다. 디스크 사용량과 남은 unknown을 관측하고, 정산되지 않은 증거를 TTL로 지우지 않는다. relay 로그는 고정된 listening/refused 코드만 기록한다.

## 개발 검증

`tests/local-model-relay.test.ts`는 localhost 가짜 HTTP 서버로 인증·출처·경로·크기·동시1·SSE 원문·client disconnect 후 drain·부분 EOF·timeout·재시작 unknown·receipt·readiness 경계를 검증한다. 운영 M1 설치나 실제 모델 추론을 포함하지 않는다.
