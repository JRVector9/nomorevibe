# M1Max 1차 검수 거둠·미확정 조사 (2026-11-18)

- 사람 지시(11/18): "M1Max 1차 거둠·미확정 원인을 서브에이전트로 조사해"
- 조사 시각: 2026-11-18 04:01Z~04:09Z, 운영 DB 읽기 전용(`ro_sql`, 5초 read only 트랜잭션), gpu3090 로컬 journal 읽기
- 재실행(04:19Z~04:30Z, 사람이 막혔던 M1Max 접근을 허용): `ssh jr-m1max`(mmm)로 M1Max 프로세스·launchd·서버 로그를 읽기만 했습니다(python3 호출 없음).
- 하지 않은 것: 운영 설정·순위·장비 한도 저장, 서버 재시작, launchd·env 변경, 운영 DB 쓰기, 장부 행 회수. 코드 변경 없음.

## 결론

**M1Max가 거의 일을 못 한 원인은 M1Max 서버가 아니라 1순위 gpu3090 호스트 정지(11/17 19:09:14Z~11/18 01:02Z)입니다.**
그 6시간 동안 1차 검수(crawl-agent-review)가 모두 2순위 M1Max로 넘어왔습니다. 그런데 M1Max는 1차 호출을 2건 동시에 받으면 둘 다 60초 상한을 넘깁니다.
M1Max 서버 로그로 확인한 까닭은 이렇습니다.

- 서버는 prefill을 한 번에 1건씩 합니다(약 110토큰/초).
- 그래서 두 번째 요청은 첫 토큰까지 61~97초를 기다립니다.
- 그동안 첫 요청의 decode도 2토큰/초로 거의 멈춥니다.
- 결과적으로 둘 다 68~106초에 끝났습니다.
- 서버는 이 시간에 재시작·오류·메모리 압박이 없었고, 요청 74건을 모두 끝까지 생성했습니다. 응답이 왔을 때 클라이언트는 이미 60초에 끊은 뒤였습니다.

- 넘긴 호출은 `client_timeout`으로 미확정이 됩니다.
- 미확정 행은 슬롯을 600초 동안 붙잡습니다(`unknownHoldSeconds` 기본값).
- 그래서 10분마다 2건만 나가고, 둘 다 다시 60초에 끊기는 일이 되풀이됐습니다.
- 나머지 대기 행은 120초 대기 기한(`queueTtlMs`)이 지나 거둠(`wait_expired`)이 됐습니다.

19Z 변화는 배포와 관계없습니다. 배포 시각은 06:20Z와 14:55Z, 다음 배포는 03:28Z였습니다. 19:09Z에 바뀐 것은 gpu3090 호스트입니다.
01Z 뒤에 줄어든 까닭은 gpu3090이 다시 켜져서 1순위로 돌아갔기 때문입니다. vLLM은 01:04:51Z에 준비됐습니다. 02Z의 20건은 02:06Z 재부팅 동안 넘어온 것입니다.

## 시간별 표 (m1max · crawl-agent-review, queued_at 기준)

| 시(UTC) | 정산 | 거둠(대기 만료/예약 만료) | 미확정(client_timeout) | 같은 시각 gpu3090 1차 |
|---|---|---|---|---|
| 11/17 18h | 0 | 0 | 0 | 정상 212건, 실행 3.7s |
| 11/17 19h | 1 (47.2s) | 239 (236/3) | 10 | 19:09:47Z부터 `gateway_not_started` 170건 |
| 11/17 20h | 0 | 397 (393/4) | 12 | 연결 실패 279건(실제 처리 0) |
| 11/17 21h | 0 | 423 (423/0) | 12 | 연결 실패 286건 |
| 11/17 22h | 0 | 430 (427/3) | 12 | 연결 실패 301건 |
| 11/17 23h | 0 | 423 (417/6) | 12 | 연결 실패 283건 |
| 11/18 00h | 1 (37.1s) | 427 (424/3) | 12 | 연결 실패 289건 |
| 11/18 01h | 0 | 63 (63/0), 01:00~01:17Z | 2 | 01:05Z부터 정상 874건 |
| 11/18 02h | 0 | 18 (18/0), 02:06~02:09Z | 2 | 02:06Z 재부팅 동안 연결 실패 17건 |
| 11/18 03h~ | 0 | 0 | 0 | 정상 |

대표가 잰 수치(19h 1/239/10 … 02h 0/18/2)와 같습니다.

**gpu3090 줄은 처리량이 아닙니다.** 19Z~01Z에 gpu3090의 "정산"으로 잡힌 행은 모두 terminal `gateway_not_started`, 곧 연결 실패입니다(약 10.9초 만에 끝남). 실제 1차 판정은 0건입니다. 화면의 "정산"만 보면 gpu3090이 느려진 것처럼 보이지만, 사실은 꺼져 있었습니다.

## 1. 19Z 전후 m1max 행의 상태 흐름

**미확정 행의 사건 순서는 모두 같습니다.**
`queued → reserved → dispatch_started → dispatch_indeterminate(reason client_timeout) → dispatch_local_ended`

- 예: request 048c3792…
  - dispatch 19:11:19.4Z → client_timeout 19:12:19.7Z
  - local_ended evidence: `terminals 1, dispatches 1`, owner m3-reviewer
  - 소유 프로세스는 살아 있었습니다. reviewer 쪽 호출이 60초 기한으로 끊긴 경우입니다.
- 6시간 동안의 미확정 사유는 모두 `client_timeout`입니다(process_exit·transport_unknown 0건).

**60초의 출처**
- crawl-agent-review의 직접 호출은 `review-gateway` 사다리 `clientMs 60_000`을 씁니다(`lib/llm/model-registry.ts:132`).
- 운영 `runtime_settings.routes`에 이 값을 바꾸는 설정은 없습니다.
- 같은 M1Max의 product-translate는 route 상한이 `timeoutMs 120000`이라 끊기지 않습니다.

**거둠의 사유**
- 19h~02h 거둠 2,420건 가운데 2,401건이 `wait_expired`입니다. 대기열에서 120초(`queueTtlMs 120000`)를 다 기다리고 만료됐습니다.
- 평균 기다림 113.9초가 120초에 가까운 까닭이 이것입니다.
- 나머지 19건은 `reservation_expired`입니다(예약 30초 안에 호출이 시작되지 않음).

**호출이 10분에 2건만 나간 까닭**
- 장비 상한은 limit_slots 2입니다. 정책 `groupLimits.m1max`와 `providerLimits.m1max`도 2입니다.
- 끊긴 미확정 행은 보낸 시각부터 600초 동안 슬롯을 셉니다(`lib/llm/capacity-unknown-hold.ts`). 운영 `runtime_settings`에 `capacity` 키가 없으므로 기본 600초가 적용됩니다.
- 그래서 디스패치가 정확히 10분 간격으로 2건씩 나갔습니다(19:11:19, 19:21:19, 19:31:20 …).
- 슬롯 2개 × 시간당 6번 = 시간당 미확정 12건입니다.

**동시 2건이면 둘 다 실패하고, 혼자면 성공했습니다**

| dispatch | 동시 호출 | 결과 |
|---|---|---|
| 11/17 19:41:20Z | 없음 | 성공 47.2s |
| 11/18 01:01:02Z | 없음 | 성공 37.1s |
| 나머지 74건 | 1건과 겹침(2건 동시) | 모두 60.2~61.9s에 client_timeout |

- M1Max가 지금까지 끝낸 1차 호출은 68건입니다(11/12~18). 평균 41.0초, 50~60초 구간이 17건입니다.
- 1차 입력은 평균 3.3천→3.9천 토큰으로 늘었습니다(README가 1차에 들어간 #981 배포 뒤). 1차는 prefill 위주라 혼자여도 60초 상한에 가깝습니다.
- 번역도 동시 2건(02:16:54Z)일 때 27~29초로, 혼자일 때(12~19초)보다 거의 두 배 느렸습니다.

**서버 로그로 본 동시 2건의 처리 순서** (`~/local-ai/logs/qwen38-api.stderr.log`, 시각은 KST, −9h가 UTC)

| KST | 서버 기록 |
|---|---|
| 04:11:20.524 / .525 | Request started in_flight=1, 2 (장부 dispatch 19:11:19Z 두 건) |
| 04:11:49.6 | 요청 A prefill 끝(3,220토큰, 28.9s, 111.5 tok/s) |
| 04:12:21.9 | 요청 B prefill 끝(3,442토큰), time_to_first_token **61.4s** |
| 04:12:28.1 / 28.8 | A 완료 elapsed **68.8s**(decode 2.3 tok/s), B 완료 **68.3s** |
| 04:41:21 → 04:42:08 | 혼자 온 요청(4,472토큰) **46.9s** 완료 (장부 19:41:20Z 정산 47.2s) |
| 04:42:16 / 17 | 2건 동시, TTFT 41.4s / **97.0s**, 완료 **105.3s / 106.1s** |

- 사건 구간(KST 11/18 04:00~10:20 = 11/17 19:00Z~01:20Z)에 서버 로그의 1차 요청은 74건입니다.
  - 장부의 디스패치 74건(미확정 72건 + 정산 2건)과 같습니다.
  - 평균 elapsed 87.2초, 60초 이하는 혼자 온 2건(46.9s, 36.8s)뿐입니다.
  - 평균 입력 4,251토큰, 최대 11,442토큰입니다.
- 서버 설정: `--max-num-seqs 3 --prefill-step-size 4096`, backend `continuous_batching`.
  - 요청은 동시에 받지만, 긴 prefill은 한 번에 하나씩 하고 그동안 다른 요청의 decode를 거의 멈춥니다.
  - 그래서 동시 2건은 1차 처리량을 늘리지 못하고 두 요청을 모두 늦게 만듭니다.
- 로그에 cancel·disconnect·error·warning 줄은 없습니다.
  - 클라이언트가 60초에 끊어도 서버는 생성을 끝까지 했습니다(장부 미확정 = 서버에서는 끝난 일).
  - 600초 hold가 막으려는 "끊긴 뒤에도 도는 생성"이 실제로 있었고, 한 쌍이 끝나는 데 약 70~106초 걸렸습니다.

**호출이 서버에 닿았는가: 닿았습니다(확인).**
- 서버 `Request started` 시각이 장부 dispatch 시각과 1초 안으로 맞습니다.
- 연결 실패(`gateway_not_started`·`transport_unknown`)는 M1Max 행에 없습니다.

## 2. 서버 쪽: gpu3090 정지와 M1Max 상태

**gpu3090(이 호스트, 1순위 qwen3.8-flash-next vLLM :8090)**
- `journalctl --list-boots`
  - boot -2: 11/07 03:45Z ~ **11/17 19:09:14Z**
  - boot -1: **11/18 01:02:19Z** ~ 02:06:24Z
  - boot 0: 02:07:30Z~
- 19:09:02Z까지 vLLM은 정상 200 응답을 냈습니다. 19:09:14Z(llm-watch 시작 줄)에서 로그가 종료 절차 없이 끊겼습니다. 커널 패닉·OOM·Xid 기록은 남지 않았습니다.
- 01:02:19Z 부팅 커널 로그: `Previous system reset reason [0x00010800]: system reset pin BP_SYS_RST_L was tripped`. 멈춘 장비를 리셋 버튼이나 외부 리셋으로 다시 켠 것입니다.
- vLLM 시작 01:02:29Z, 서버 준비 01:04:51Z.
- 02:06:18Z: `ubuntu : TTY=/dev/pts/3 ; COMMAND=/usr/bin/systemctl reboot`. 사람이 의도적으로 재부팅했고, 02:10:01Z에 vLLM이 준비됐습니다.
- 멈춘 원인(하드웨어·드라이버·온도)은 남은 로그가 없어 확정하지 못했습니다. 지금 GPU 4장은 74/69/65/68°C, 팬 81~100%입니다.

**M1Max(Qwen3.8-27B-4bit, https://jr-m1max.tail02799e.ts.net/v1)**

재실행 때 서버에서 직접 본 사실(04:19Z~):

- **장비**
  - 부팅 11/11 18:09 KST, uptime 6일 19시간. 장비 재부팅은 없었습니다.
  - 메모리 32GB, 지금 여유 91%, swap 0.
  - `pmset -g therm`: 온도·성능 경고 기록 없음.
  - `pmset -g log`: 잠자기 없음. caffeinate가 잠자기를 막고 있습니다.
- **서버 프로세스**
  - launchd `local.mlx.qwen38` PID 62018, 시작 **11/17 20:17:23 KST = 11:17:23Z**. APC를 1로 되돌린 때이고, 그 뒤 재시작이 없습니다.
  - stderr 로그의 모델 로드는 20:02:25 KST(11:02Z, APC 4)와 20:17:25 KST(11:17Z, APC 1) 두 번뿐입니다. **19Z 무렵 서버 재시작은 없었습니다.**
- **실행 환경 값**
  - `APC_CHECKPOINT_ENTRIES=1`, `APC_ENABLED=1`, `APC_MEMORY_MAX_GB=1.5`, `PREFILL_STEP_SIZE=4096`, `MAX_KV_SIZE=131114`, `MLX_FORCE_NO_THINKING=1`.
  - 되돌림이 실제로 적용돼 있습니다.
  - `serve_qwen38.py`는 `.bak-20261117-apc1`과 같습니다. `.bak-…-apc4`와의 차이는 그 한 줄뿐입니다.
- **서버 파일 시각**(KST)
  - `.bak-nothink` 08:46
  - `.bak-exec` 12:01(= 03:01Z)
  - 현재 파일 14:32
  - `.bak-apc4` 20:02
  - `.bak-exec`에서 현재 스크립트로 바뀌며 `mlx_vlm.server` 직접 실행과 `force_no_thinking`이 들어갔습니다. 11/17 03Z부터 번역이 50초에서 15초로 빨라진 시각과 맞습니다(생각 토큰을 더 만들지 않음).
- **사건 구간 처리 속도**
  - 1차 prefill 111~118 tok/s로, 지금(106 tok/s)과 같은 수준입니다.
  - 서버 자체가 느려진 흔적은 없습니다.

장부로 본 사실:
- 같은 M1Max의 product-translate(입력 약 750토큰)
  - 11/16: 실행 44~64초
  - 11/17 03Z부터: 12~18초로 빨라짐
  - 11/17 18Z까지 그대로 정상
- 11:02Z~11:17Z APC_CHECKPOINT_ENTRIES 4→1 변경 전후
  - 번역 시간: 10h 14.3s, 11h 17.7s, 12h 14.2s
  - 변화가 보이지 않습니다. **APC 되돌림이 남긴 지속 영향은 장부에서 찾지 못했습니다.**
- 19Z~01:30Z 번역 0건 정산
  - 서버 고장이 아닙니다. 1차 미확정 행이 슬롯 2개를 600초씩 계속 붙잡아 번역이 대기 만료·취소된 것입니다.
  - 01:30Z부터 번역은 다시 11~20초로 정상 처리됐습니다.
- **11/18 02:50Z~03:12Z 이상**
  - 혼자 나간 번역이 45~107초 걸렸습니다.
  - 장부에는 겹치는 M1Max 호출이 없습니다.
  - 서버 로그(KST 11:50~12:13)에서도 대부분 in_flight=1인데, prefill이 26~32 tok/s(평소 106), decode가 1.4~3.2 tok/s(평소 19.7)로 서버 전체가 3~6배 느렸습니다.
  - 같은 GPU를 쓰는 다른 일이 있었다고 보지만, 무엇인지는 확인하지 못했습니다. 지금은 다른 모델 프로세스가 없고 온도·잠자기 기록도 없습니다.
  - 대표가 잰 "번역 6h 실행 32.3s"는 이 구간이 끌어올린 값입니다.

**대표의 11/17 직접 호출 시험(50건)**
- 서버 로그의 시간당 완료 수(KST)는 11/17 18시 168건, 19시 27건, 20시 162건입니다.
- 이것은 09Z·11Z 무렵의 직접 시험으로 보입니다. 그 뒤 KST 21~23시는 1~10건이었습니다.
- 11:17Z 재시작 뒤로 서버 속도와 설정은 그대로였고, 19Z 사건(KST 04시)과 이어지는 흔적은 없습니다.
- **APC 변경·되돌림과 직접 시험은 19Z 사건의 원인이 아닙니다.**

## 3. 01Z 뒤에 줄어든 까닭

- 대기 자체가 줄었습니다. 1순위가 다시 일을 받기 시작했기 때문입니다.
- gpu3090의 `gateway_not_started` 행은 19:09:47Z에 처음 나왔고, 01:00Z~01:57Z에 34건, 02:04Z~02:20Z에 51건이 있었습니다.
- 01:05Z부터 gpu3090 1차 실제 처리는 시간당 874~899건이었습니다. 쌓인 일을 한꺼번에 처리한 것입니다.
- M1Max 1차 행
  - 01h: 01:00:00~01:17:08Z, vLLM 준비 전후에 줄을 섰던 행
  - 02h: 02:06:37~02:09:22Z, 재부팅 4분과 정확히 겹침
- 순위·한도·코드 변경은 그 사이에 없었습니다.
  - 순위 저장: 11/14 11:27Z(jr-claude)
  - 장비 표 m1max: 바뀐 기록 없음
  - capacity 정책: epoch 1 revision 38
  - control `updated_at` 03:28Z는 배포 시각입니다.

## 4. 미확정 288건의 부담(04:0xZ 기준)

| 범위 | 열린 미확정 | 보낸 시각 범위 | 지금 슬롯 점유(600s 안) |
|---|---|---|---|
| m1max crawl-agent-review | 183 | 11/12 14:24Z ~ 11/18 02:06Z | 0 |
| m1max product-translate | 105 | 11/12 14:58Z ~ 11/15 12:53Z | 0 |
| (참고) 전체 장부 | 531 | 11/11~11/18 | 0 |

- **배포 관문**
  - `scripts/ops/deploy_release.py`의 model 관문은 `dispatched`와 살아 있는 `reserved`만 0인지 봅니다.
  - 미확정은 `review` 숫자로 보고만 하고 막지 않습니다.
  - 지금 600초 안의 미확정은 0건이라 슬롯도 붙잡지 않습니다. **배포를 막는 부담은 0입니다.**
- **사람 검토**
  - 마지막 `dispatch_reviewed`(사람 검토로 닫음)는 11/11 04:05Z입니다(누적 396건).
  - 그 뒤 생긴 미확정은 아무도 닫지 않았습니다. m1max 288건은 사람 검토 목록에 그대로 쌓여 있습니다.
- **업무 손실**
  - m1max 1차 미확정 183행은 후보 144개입니다.
  - 이번 사건(11/17~18) 후보 74개는 모두 01:05Z 뒤 gpu3090이 실제로 다시 판정했습니다.
  - 나머지 70개 중 59개도 다른 곳에서 실제 판정이 있었습니다.
  - 남은 11개(771853 … 774613)는 지금 published 4개, rejected 7개로 끝나 있습니다.
  - 다시 처리되지 않은 1차 작업은 0건입니다. 288건은 장부 기록상의 부담이지 업무 적체가 아닙니다.
- **실제 피해(6시간)**
  - 1차 실제 판정은 19:09Z~01:05Z 동안 M1Max의 2건뿐이었습니다.
  - 같은 기간 M1Max 번역도 0건이었습니다.

## 5. 고치는 선택지

| 선택지 | 무엇을 | 효과 | 위험 | 되돌리기 |
|---|---|---|---|---|
| **A. 1차 2순위에서 M1Max 빼기** (추천) | `ai-task-ranks set first-review`로 1순위 gpu3090만 남기거나, 2순위를 다른 대체 모델로 바꾼다(`--operator` 필수) | gpu3090이 꺼져도 미확정·대기 만료가 쌓이지 않고 번역 슬롯이 굶지 않는다. 6시간에 2건이었으니 1차 손실은 사실상 없다 | gpu3090이 꺼지면 1차가 깨끗이 멈춘다(지금도 사실상 멈춤). 다른 2순위를 넣으면 그 모델의 1차 품질·용량을 따로 확인해야 한다 | 같은 명령으로 2순위 M1max·Qwen3.8-27B-4bit를 다시 저장 |
| B. M1Max 1차를 동시 1로 제한 | 장비 표 m1max `route_quotas`에 crawl-agent-review 몫 1을 주거나, limit_slots를 1로 낮춘다 | 서버가 prefill을 한 번에 1건씩 하므로 동시 2건은 처리량을 늘리지 못한다. 혼자일 때 37~47초. 사건 구간 74건의 입력·출력 길이로 혼자 처리 시간을 계산하면(prefill 110 tok/s, decode 19.7 tok/s) 약 6건(8%)만 60초를 넘는다 | 입력 약 5,800토큰을 넘거나 번역과 겹치면 여전히 끊긴다. limit_slots 1이면 번역도 동시 1로 줄어든다. 한 번 끊기면 600초 동안 슬롯이 묶이는 구조는 그대로다 | 장비 표 값을 2·[]로 되돌림 |
| C. 코드: 공급자별 1차 기한 | M1Max 같은 느린 직접 엔진에 별도 deadlineLadder(예: client 150s)를 쓰게 하는 PR | 동시 2건이라도 끊기지 않고 끝날 수 있다 | review-gateway 사다리는 1차·2차가 함께 쓴다. live-call 창(`lib/crawl/ai1-live-call.ts`), 중복 접수 fence, 대기 줄 길이가 모두 이 값에 묶여 있어 회귀 범위가 넓다. 시험과 배포 창이 필요하다 | PR 되돌림 |

**추천: A를 먼저 적용하고, 별도로 gpu3090 정지를 빨리 알아차릴 경보를 둔다.**

- gpu3090은 19:09Z에 멈춘 뒤 6시간 가까이 지나 01:02Z에 손으로 리셋됐습니다.
- 경보 예: 1순위 `gateway_not_started`가 10분 넘게 이어지면 알림.
- M1Max를 1차 예비로 계속 쓰고 싶다면 A 다음에 B를 짧게 시험하는 순서가 안전합니다. 동시 1로 혼자 나간 1차가 60초 안에 끝나는 비율을 잰 뒤 다시 넣습니다.

**함께 볼 것(결정은 사람 몫)**
- 미확정 288건을 사람 검토로 닫을지(`dispatch_reviewed`)는 이 조사에서 하지 않았습니다.
- 업무는 모두 다시 처리됐으므로, 닫아도 용량·업무에 주는 영향은 없습니다. 검토 목록만 정리됩니다.

## 증거(명령·시각)

| 시각(UTC) | 명령 / 출처 | 본 것 |
|---|---|---|
| 04:01:54 | `ro_sql "SELECT now(), count(*) FROM model_capacity_requests WHERE provider_budget_id='m1max'"` | 접근 확인, m1max 6,704행 |
| 04:0x | `ro_sql` 시간별 상태 × 마지막 event(kind/from/reason), m1max·crawl-agent-review, queued_at ≥ 11/17 12Z | 위 표, 모든 미확정의 마지막 event `dispatch_local_ended`, 거둠은 `wait_expired`/`reservation_expired` |
| 04:0x | `ro_sql` 미확정 행 event 전체(048c3792…, 9bab405b…, 671f54da…) | dispatch → 60.2s 뒤 `client_timeout`, evidence `terminals 1 dispatches 1` |
| 04:0x | `ro_sql` crawl-agent-review 모든 공급자 시간별 상태·기다림·실행 | gpu3090 19Z부터 실행 10.9s, 01Z부터 900건/h |
| 04:0x | `ro_sql` gpu3090 정산 terminal kind 시간별 | 19:09:47Z~02:20Z 모든 경로 `gateway_not_started` 2,005건 |
| 04:0x | `journalctl --list-boots`, `journalctl -b -2 -n 40`, `journalctl -b -1 \| grep 'reset reason\|COMMAND'` (gpu3090 로컬) | 19:09:14Z 로그 끊김, 01:02:19Z reset pin, 02:06:18Z `sudo systemctl reboot` |
| 04:0x | `systemctl status qwen38fn.service`, `journalctl -u qwen38fn.service` | vLLM `--max-num-seqs 6`, 01:04:51Z / 02:10:01Z 준비 |
| 04:0x | `ro_sql model_capacity_control`, `runtime_settings` | queueTtlMs 120000, reservationTtlMs 30000, groupLimits/providerLimits m1max 2, `capacity` 키 없음(hold 기본 600s), routes.limits에 crawl-agent-review 기한 없음 |
| 04:0x | `ro_sql ai_task_models ⋈ ai_connections` (first-review) | 1 gpu3090-qwen qwen3.8-flash-next, 2 M1max Qwen3.8-27B-4bit, 둘 다 11/14 11:27:00Z jr-claude |
| 04:0x | `ro_sql model_serving_contracts` (Qwen3.8-27B-4bit) | crawl-agent-review·product-translate direct 계약, 11/12 저장 |
| 04:0x | `ro_sql` m1max 정산 terminal 분포 | 실제 완료 68건 평균 41.0s(최소 8.6, 최대 60.2), 연결 실패 200건(11/12~13) |
| 04:0x | `ro_sql` 입력 토큰(actualUsage.inputTokens) 배포 전후 | gpu3090 3,291 → 3,807 → 4,241, m1max 3,305 → 3,856 |
| 04:0x | `ro_sql` m1max 디스패치 목록 → 겹침 계산(scratch) | 혼자 2건 성공, 2건 동시 72건 모두 timeout, 02:50~03:12Z 번역 혼자 45~107s |
| 04:0x | `ro_sql` 열린 미확정 집계, `dispatch_reviewed` 집계 | 위 4절 표, 마지막 사람 검토 11/11 04:05Z |
| 04:0x | `ro_sql` 미확정 work key의 다른 공급자 실제 완료, `crawl_candidates.state` | 74/74 다시 판정, 11개 published 4 / rejected 7 |
| 04:0x | `m3 docker ps`, `docker inspect StartedAt` | reviewer 컨테이너(app-copy-primary-hard-drive-b5fhzd) 시작 11/18 03:22:48Z라 19Z~02Z 로그 없음 |
| 04:19:39 | `ssh jr-m1max 'hostname; uptime; date -u; sysctl -n kern.boottime; launchctl list \| grep -E "mlx\|qwen"; ls -la ~/local-ai/'` | 부팅 11/11 18:09 KST, launchd PID 62018, 백업 파일 시각 |
| 04:2x | `ssh jr-m1max 'ps -o pid,lstart,etime,rss,command -p 62018; grep … ~/Library/LaunchAgents/local.mlx.qwen38.plist'` | 서버 시작 11/17 20:17:23 KST, `--max-num-seqs 3 --prefill-step-size 4096` |
| 04:2x | `ssh jr-m1max 'cat serve_qwen38.py'(비밀 줄 제외), diff .bak-apc1 .bak-apc4, diff .bak-exec 현재` | APC 1 적용, 차이는 그 한 줄, 03:01Z 변경은 force_no_thinking |
| 04:2x | `ssh jr-m1max 'grep -E "^2026-11-1(7 …\|8 …)" ~/local-ai/logs/qwen38-api.stderr.log'` → scratch 5,418줄 | 사건 구간 1차 74건, 평균 87.2s, 동시 2건의 차례 prefill, 오류·cancel 0, 모델 로드 2번(11:02Z·11:17Z) |
| 04:2x | `ssh jr-m1max 'sysctl hw.memsize vm.swapusage; memory_pressure -Q; pmset -g therm; pmset -g log; ps -Ao …; last'` | 32GB, 여유 91%, swap 0, 온도 경고 없음, 다른 모델 프로세스 없음 |

## 확인하지 못한 것

- **M1Max 접근 경로**
  - 이 실행 환경에는 지시된 `xa-ssh` 명령이 없고, `xa-devices list`에도 M1Max가 없습니다.
  - 첫 실행에서는 ssh 설정의 `jr-m1max`(mmm) 별칭으로 시도한 읽기 명령이 자동 승인 검사에 막혔습니다: `ssh -o BatchMode=yes jr-m1max 'hostname; uptime; date -u'`.
  - 재실행에서 사람이 이 요청을 허용해, 같은 경로로 읽기만 했습니다.
- **11/18 02:50~03:12Z에 서버 전체가 느려진 원인**: 다른 GPU 사용 프로세스의 흔적이 지금은 없습니다. 로그도 없어 확정하지 못했습니다.
- **조사 중 비밀값 노출(사고 기록)**: 재실행에서 `ps eww`로 실행 환경 값을 거를 때 패턴이 넓어, 서버 API 키 변수(`MLX_VLM_SERVER_API_KEY`)의 값이 이 작업 세션의 명령 출력에 나왔습니다. 파일·커밋·보고서에는 넣지 않았습니다. 키 교체를 권합니다(사람 결정).
- **reviewer·ai2-consumer 컨테이너 docker logs(19Z~02Z)**: 03:2xZ 배포로 컨테이너가 바뀌어 남아 있지 않습니다.
- **gpu3090이 19:09:14Z에 멈춘 원인**: 커널·드라이버 기록이 남지 않았습니다. BMC/IPMI 기록은 보지 않았습니다.
- **01:02Z 리셋을 누가 했는지**: 실제 버튼인지 원격 전원 제어인지 알 수 없습니다.
- **monitor `check-worker-progress --json`**: 실행하지 않았습니다. 장부와 journal로 시간대가 확정돼 따로 필요하지 않았습니다.
- **19Z~01Z 사이 1차 적체 경보가 울렸는지, 누가 알아차렸는지**: 확인하지 않았습니다.
- **대표의 11/17 50건 직접 호출 시험의 정확한 시각과 대상 서버**: 장부에 남지 않았습니다.
- 사람 원문 "M1MAx 랑 50건 표본 둘다 서브에이전트로 각각 진행해봐" 가운데 50건 표본은 이 작업 범위가 아니라 다루지 않았습니다.
