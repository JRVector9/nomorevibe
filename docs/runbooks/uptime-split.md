# 응답 점검 제품 단위 분담(split-v1) runbook (U1c)

제품 연결 확인(`uptime-ping`)을 home(M3·mini)과 probe(Oracle)가 제품 단위로 나눠 맡는다. 제어는 `uptime_split_control` 한 행(0103)이다.

| mode | 누가 확인하나 | 정식 기록(health·연속 실패·숨김·내림) |
|---|---|---|
| legacy(기본) | maintenance `uptime-ping` 잡이 지금 방식(`nextToCheck` → `recordPing`, 틱 광역 실패 보류) | 그 잡이 바로 쓴다. `uptime_claims` 를 보지 않는다 |
| claims | 같은 잡이 claim 경로로(home), policy 에 있는 Oracle consumer(probe, U2) | home 잡의 묶음 적용기만 쓴다(`uptime-apply.ts`). Oracle 은 결과를 제출만 한다 |

전환은 `scripts/ops/uptime-split.ts` 로만 한다. 이 문서의 운영 단계는 **모두 사용자 승인 뒤** 실행한다.

## 먼저 알아야 할 것

1. **모드는 틱 시작에 한 번 읽는다.** 전환은 epoch+1 한 번이고 다음 틱(최대 1분)부터다. draining 이 없다 — 전환 순간 겹친 확인은
   6시간 최소 간격(`minimum_interval`)·더 새 기록(`older_observation`)·제어 epoch(`control_epoch`)·`mode_legacy` 판정이 막아 두 번 세지 않는다.
   낭비는 최대 한 틱 분량의 이중 확인이다(통합 테스트 `uptime-split-job.test.ts` "legacy ↔ claims 전환").
2. **claims 틱 순서**(home 잡): ① Oracle 등 제출분 반영(결과가 없어도 틱마다 — 차단기를 open → probing 으로 진행) ② 내림 적체 sweep(legacy 와 같다)
   ③ 새 공개 제품의 claim 행(틱마다 2,000건까지) ④ home claim(재확인 요청 먼저, `UPTIME_BATCH_SIZE` 까지) ⑤ 확인(legacy 와 같은 HTTP·본문·서버 직렬,
   `uptime-check.ts`) ⑥ **틱 결과를 한 번에 반영** ⑦ 반영 못 한(열지 않았거나 적용이 실패한) claim 은 풀로 되돌림.
3. **판정**(`decideSplitResults`): 성공은 어느 host 것이든 반영한다. Oracle 실패는 세지 않고 home 재확인을 요청한다. home 실패도 그 host 차단기가
   닫혀 있고 이번 묶음이 광역 모양이 아닐 때만 센다. 숨김 3회·내림 10회·최종 commit 보호·사람 unban 보호는 그대로다.
4. **home 광역 기준은 legacy 와 같다**: 한 틱(묶음) 30건 이상에서 실패가 30% 초과면 그 실패를 세지 않는다. claims 에서는 여기에 더해 그 host 차단기가
   열려(기본 10분) 다음 틱부터 확인을 쉬고(반영·sweep 은 계속), cool-down 뒤 30건만 시험해 5% 이하면 닫는다. 그래서 policy 의
   `batchMin`·`batchOpenRatio` 는 30·0.3 이어야 하고 도구가 다른 값을 거절한다(`policy_batch_rule_differs_from_legacy`).
   세지 않은 home 실패(`split_broad_failure`)는 legacy 광역 보류와 같은 **판정 보류**다 — 확인 시각만 넘기고(연속 실패·응답 코드·첫 실패 시각·
   일일 집계 그대로) 다른 제품처럼 6시간 뒤 차례에 둔다. 재확인 요청도 그 확인으로 끝난다. 연속 실패가 10 이상인 행(관리자가 풀어 준 제품)은
   확인 시각도 그대로 두고(자동 내림 최신성·관리자 해제 비교 기준) 15분 뒤 다시 본다.
5. **`minChecks` 는 100 이하**(`policy_min_checks_above:100`). 200 이면 Oracle 1,000건/시간(10분 약 167건)에서 창 규칙이 영영 열리지 않는다.
   **probe `maxPerHour` 합계는 5,000 이하**(`policy_probe_rate_above:5000`). 제출분은 home 적용기가 1분 틱마다 100건만 반영해(시간당 최대 6,000)
   그보다 빨리 내면 `submitted` 가 쌓이기만 한다.
6. **PR09 관측·gate(`uptime_control`)와 함께 켤 수 없다.** split 을 claims 로 하려면 PR09 가 disabled 여야 하고(`uptime_control_enabled`),
   claims 동안 `uptime-gate.ts` 의 raw-only·gate 전환은 거절된다(`uptime_split_claims_active`). DB 트리거(0103)가 같은 것을 강제하고, 경합으로
   트리거에 닿으면 두 도구 모두 오류가 아니라 거절(`uptime_split_requires_uptime_control_disabled` / `uptime_control_requires_split_legacy`)로 돌려준다.
   PR09 를 켜야 하면 먼저 `mode --to=legacy`.
7. **claims 동안 `job_batch_control` 을 versioned 로 바꾸지 않는다.** Oracle product-health 역할 잡이 claim 권한 없이 같은 잡을 돈다.
   양쪽 도구가 막는다: claims 전환은 batch 가 legacy 일 때만(`batch_mode_not_legacy:<mode>`), claims 동안 `pipeline-control batch drain`(legacy→)·
   `batch complete --to=versioned` 는 거절(`uptime_split_claims_active`). 두 도구는 서로의 제어 행을 잠근 뒤 다시 판정하므로(split → batch 순서)
   동시에 실행해도 둘 다 통과하지 않는다. versioned→legacy 길은 막지 않는다.
8. **최근 24시간 maintenance 후보(`candidate:maintenance:<id>`)는 모두 policy 에 home 으로 있어야 한다**(`uptime_runner_unconfigured:<id>`).
   policy 에 없는 instance 가 역할을 쥐면 그 잡은 claim·확인을 하지 않는다(`uptime.split_blocked unconfigured`) — 확인이 멈춘다.
9. **코드를 되돌리기(이전 SHA 재배포) 전에 반드시 `mode --to=legacy` 부터 한다.** U1c 이전 코드의 `uptime-ping` 은 split 모드를 모르고 legacy 로만 돈다.
   claims 그대로 두면 Oracle consumer 는 계속 claim·제출하는데 그 제출을 반영할 적용기가 없어 `submitted` 가 쌓이고, Oracle 이 가져간 제품은
   legacy 와 중복 확인된다. 순서: `mode --to=legacy` → legacy 틱 1회 확인(아래 "되돌리기") → Oracle unit 정지 → 코드 되돌리기.
10. DR 봉인은 `uptime_claims` 의 token 을 회수한다(U1b). 승격 뒤 claims 모드 그대로 다시 claim 된다.
11. **제출은 probe(Oracle)만 한다.** home 결과는 home 잡이 적용기에 직접 넘긴다. 적용기는 home host·class 로 적힌 제출 행을 판정하지 않고 버린다
   (`submitted_not_probe`, due 그대로) — Oracle 계정의 열 UPDATE 권한으로 "home 이 본 실패" 를 위조해도 세지 않는다. 그래서 consumer 를 home 항목으로
   돌리는 방식(A4 "두 번째 home consumer")은 지원하지 않는다(consumer 는 `home_unsupported` 로 쉬고, 제출 API 도 home instance 를 거절한다).
12. **비표준 HTTP 상태**(100..599 밖, 예: LinkedIn 999·600)는 legacy 와 같은 값·같은 의미로 기록한다 — `product_health.status` 에 그대로.
   100..599 만 담는 `uptime_observations`·제출 칸에만 `unknown/0` 으로 남는다(Oracle 이 본 999 는 `unknown:0` 재확인 요청이 된다).
   **봇·로그인 차단 응답(401·403·429·999)** 은 legacy(#551 F7)와 같이 살았는지 알 수 없는 응답이다. home 이 보면 세지도 끊지도 않고 확인 시각·
   응답 코드만 남긴다(`split_unknown`, 일일 집계 없음, 자동 내림 확인 안 함 — sweep 도 마지막 응답이 이 목록이면 고르지 않는다). Oracle 이 보면
   다른 실패처럼 home 재확인을 요청한다. 차단기 비율(묶음·창)에서는 legacy 광역 비율처럼 실패 쪽에 센다. 그 밖의 비표준 상태(600 등)는 실패다.
   목록은 `health-record.ts` `UPTIME_UNKNOWN_STATUSES` 하나다 — legacy(`recordPing`)와 적용기(판정 `unknown` → `writeHealthUnknowns`)가 같이 쓰고,
   한쪽 의미만 바뀌면 적용기가 `uptime_split_health_mismatch` 로 틱을 되돌린다(쌍둥이 시험 `uptime-split-twin.test.ts` 가 막는다).
   한 건의 결과 모양이 틀리면(`uptime.split_result_invalid`) 그 건만 반영에서 빠지고 TTL 뒤 다시 잡힌다.
13. **host 시계.** home 잡·Oracle consumer 는 claim 전마다 host−DB 시계 차를 잰다. 20초를 넘으면 claim·확인을 쉰다(home: 이벤트
   `uptime.split_clock_skew`, consumer: 쉼 사유 `clock_skew`·관측 키 `clockSkewMs`). 그래도 ±30초 밖으로 판정된 결과(`clock`)는 due 를 15분 미룬다.
   이 이벤트가 보이면 그 host 의 chrony·NTP 를 본다 — 고칠 때까지 그 host 는 확인하지 않는다.
14. **차단기 시험(probing) 표본은 건강한 제품만**(연속 실패 0, 재확인 요청 아님)이다. 실제로 죽은 사이트의 재확인 요청은 닫힌 뒤 맨 앞에서 센다.
   `opened_at` 은 열림 구간의 시작이다(시험에서 다시 열려도 이어 감).

## 실행 환경

- 실행 위치: 운영 DB primary 에 쓰기로 접속 가능한 maintenance 계열 컨테이너. `node --import tsx scripts/ops/uptime-split.ts <명령>`.
- DB URL 은 `UPTIME_SPLIT_DATABASE_URL` 환경변수로만 준다(셸 기록에 남지 않게). 앱 `DATABASE_URL` 로 대체하지 않는다. 복제본 URL 은 쓰지 않는다.
  `PGHOST`·`PGHOSTADDR`·`PGPORT`·`PGSERVICE`·`PGSERVICEFILE`·`PGOPTIONS` 가 있거나 URL 을 인자로 주면 거절한다.
- 명령
  - `status [--json]` — 읽기 전용.
  - `policy --file=<json> --expect-epoch=E --expect-policy-hash=<HASH|none> --operator=<이름> --reason="<사유>" [--execute]`
  - `mode --to=claims|legacy --from-mode=legacy|claims --expect-epoch=E --operator=<이름> --reason="<사유>" [--execute]`
- 전환은 기본 dry-run 이다(읽기 전용 TX, DB 쓰기 0). `--execute` 면 한 TX 에서 DR fence(SHARE) → `uptime_control`(SHARE) → split 행(UPDATE)을
  잡고, 잠근 상태로 같은 판정을 다시 해 기대값(epoch·mode·policy hash)이 맞을 때만 split 행(epoch+1)과 `operations_audit` 1행을 함께 commit 한다.
- 출력: 사람이 읽는 표, `--json` 이면 JSON 한 줄. exit `0`=완료·허용, `3`=거절(아무것도 쓰지 않음), `1`=오류(stderr 에 고정 code 만).
- 감사 행: `action`=`uptime-split-policy`/`uptime-split-mode`, `target`=`uptime_split_control`, `detail`={`reason`, `expected`, `change`, `warnings`,
  `before`, `after`(policy 포함)}. `actor_kind` 는 비어 있다(스크립트 행 관례). 지울 수 없다(0056).

## policy 파일

```json
{ "version": 1,
  "hosts": [
    { "host": "m3", "instanceId": "<M3 maintenance SERVICE_INSTANCE_ID>", "region": "<운영자 지정>", "class": "home" },
    { "host": "mini", "instanceId": "<mini maintenance standby SERVICE_INSTANCE_ID>", "region": "<운영자 지정>", "class": "home" } ],
  "claim": { "ttlMs": 180000 },
  "confirm": { "affinityDays": 7 },
  "breaker": { "windowMinutes": 10, "minChecks": 100, "openRatio": 0.08, "batchMin": 30, "batchOpenRatio": 0.3,
               "coolDownMinutes": 10, "maxCoolDownMinutes": 60, "probeSize": 30, "probeCloseRatio": 0.05 } }
```

- `instanceId` 는 각 실행자의 `SERVICE_INSTANCE_ID`, `region` 은 운영자가 정한 식별자다(이름에서 추론하지 않는다). 같은 host 는 같은 region.
- class 는 host 로 정해진다: M3·mini=home, `oracle-osaka-smoke`=probe(`region` 은 `ap-osaka-1`, `maxPerHour`·`batch`·`concurrency` 필수).
- `coolDownMinutes ≥ windowMinutes`(닫힌 직후 창에 남은 실패로 바로 다시 열리지 않게).
- policy 를 바꾸면 epoch+1 이다. claims 중이면 그 순간 나가 있던 claim·제출은 버려지고(`in_flight_claims_discarded`) due 그대로 다시 claim 된다.

## 순서

### A2 전제 — 0103 적용·U1a~c 배포(동작 변화 없음)

```sh
node --import tsx scripts/ops/uptime-split.ts status > split-status-before.txt
```

확인: `mode=legacy`, `[queue]` 의 `행 없음`이 0 근처(0103 백필 뒤 새 제품만), `maintenance 후보(24h)` 에 M3·mini maintenance instance 가 보인다.

### A3 — home 만 claims

1. home 2개 policy 파일을 쓴다(위 예시). dry-run → `--execute`:

   ```sh
   node --import tsx scripts/ops/uptime-split.ts policy --file=home.json --expect-epoch=E --expect-policy-hash=none \
     --operator=<이름> --reason="A3 home policy"
   node --import tsx scripts/ops/uptime-split.ts policy --file=home.json --expect-epoch=E --expect-policy-hash=none \
     --operator=<이름> --reason="A3 home policy" --execute
   ```

2. `status` 로 새 epoch `E+1` 을 확인하고 claims 로 바꾼다(dry-run 에서 거절·경고를 먼저 본다):

   ```sh
   node --import tsx scripts/ops/uptime-split.ts mode --to=claims --from-mode=legacy --expect-epoch=E+1 \
     --operator=<이름> --reason="A3 claims home"           # dry-run
   ...  --execute
   ```

3. 6시간(한 바퀴) 관측. 통과 조건:
   - `[queue]` due 최장 ≤ 12분(마지막 확인 뒤 6.2시간), 5분 반영이 끊기지 않는다.
   - `확인 중`이 배치 크기 근처를 넘지 않고, 잡 이벤트에 `uptime.split_blocked` 가 없다(있으면 사유를 본다).
   - 1시간 판정 사유에 `claim_lost`·`clock`·`product_changed` 가 드물다. `split_broad_failure` 가 없다(있으면 그 시각 M3 네트워크를 본다).
   - 숨김(failures≥3)·내림 속도가 legacy 때와 비슷하다(아래 SQL).

### A6 — Oracle 추가(cap 1,000/h)

전제: U2(consumer)·B0(Oracle consumer 실행 경로) 배포, Oracle unit 미시작, preflight `ready`.

1. policy 에 Oracle 항목을 더한다(home 2개는 그대로):

   ```json
   { "host": "oracle-osaka-smoke", "instanceId": "uptime-consumer-oracle", "region": "ap-osaka-1", "class": "probe",
     "maxPerHour": 1000, "batch": 40, "concurrency": 4 }
   ```

   `policy --file=with-oracle.json --expect-epoch=E --expect-policy-hash=<status 의 지금 hash> ... --execute`
2. Oracle uptime consumer unit 을 시작한다. 6시간 관측: `[1h] host별 반영`에 `oracle-osaka-smoke` 가 생기고, `제출 대기` 최장이 2분 안팎,
   재확인 대기(`confirm`) 최장이 몇 분 안이다.

### A7 — 확대(하루씩)

`maxPerHour` 2,000(`concurrency` 6) → 3,500(`concurrency` 8). 매번 `policy` 로 바꾸고(epoch+1) 하루 관측한다.
본다: 충돌률, home 재확인 부하(시간당 `split_confirm_required`), 차단기, M3 maintenance 줄 여유(`check-worker-progress` lanes).

## 중단 조건(경보 → 사람 판단)

| 조건 | 어디서 보나 |
|---|---|
| due 최장 > 60분(마지막 확인 뒤 7시간) | `status` `[queue]`, 운영센터 "응답 점검 분담" `최장 지남(분)`, `check-worker-progress` 의 `uptime` 단계 |
| 재확인(confirm) 최장 > 30분 | `재확인 최장(분)` |
| 제출(submitted) 최장 > 10분 | `제출 최장(분)` |
| Oracle 음성 비율 > M3 의 3배 | 아래 SQL |
| 충돌률(Oracle 실패 → home 성공) > Oracle 확인의 2% | 아래 SQL |
| 차단기가 1시간에 3번 넘게 열림 | `[breaker]`, 잡 이벤트 `uptime.split_blocked`·`uptime.broad_failure_held`, 아래 SQL(근사) |
| 확인을 맡은 home 의 차단기가 60분 넘게 열림 | `check-worker-progress` `uptime` 단계 `upstream_stalled`(경보), 운영센터 "응답 점검 분담" 설명 앞 `경보:` |
| host 시계 어긋남 | 잡 이벤트 `uptime.split_clock_skew`, consumer 관측 키 `reason=clock_skew`·`clockSkewMs` |
| `uptime_claims`·제품 lock 대기·lock timeout | 잡 오류(`jobs.last_error`), DB 대기 이벤트 |
| M3 maintenance 잡 오류 | 운영센터 수집기 목록 `uptime-ping`, `jobs.last_error` |
| Oracle RSS > slice 70% | Oracle unit 상태(U2·B0 runbook) |

```sql
-- 최근 1시간 host 별 반영·Oracle 재확인 요청·충돌(시각은 timestamptz)
select last_applied_host, count(*) from uptime_claims where last_applied_at > now() - interval '1 hour' group by 1;
select host, reason, count(*) from uptime_observations
 where received_at > now() - interval '1 hour' and reason like 'split_%' group by 1, 2 order by 1, 2;
-- 충돌률 ≈ split_confirm_success / (Oracle 반영 + split_confirm_required)
-- 차단기 열림(근사): home 은 split_broad_failure 가 생긴 분, Oracle 은 probe_breaker_open 으로 돌려준 수
select date_trunc('minute', received_at) as minute, host, count(*) from uptime_observations
 where received_at > now() - interval '1 hour' and reason = 'split_broad_failure' group by 1, 2 order by 1;
```

## 관측 지표

- `status`: mode·epoch·policy hash·PR09 상태, host 목록, `[queue]`(due·최장, 확인 중, 제출 대기·최장, 재확인 대기·최장, 5분 반영, claim 행 없음),
  `[1h]` host 별 반영, `[breaker]` host 별 차단기(사유·비율·시험 시각)와 최근 1시간 판정 사유.
- 운영센터 → 파이프라인 제어 상태 → "응답 점검 분담" 카드: 같은 장부(복제본, 같은 SQL).
- `check-worker-progress`(배포 관문): **claims 모드에서만** `uptime` 단계(role maintenance, job `uptime-ping`)가 생긴다. 대기 = 가져갈 수 있는 due + 제출 대기,
  진행 = 최근 5분 정식 반영. home 차단기가 열려 쉬는 동안은 `backoff`(경보 아님)다 — 재시작으로 고칠 수 없는 의도한 대기다. 시험 시각이 지났는데
  진행이 없으면 지금 규칙대로 `no_progress`/`worker_missing` 경보다. legacy 에서는 이 단계가 없어 관문 판정이 지금과 같다.
  **확인을 맡은 home**(maintenance 역할 임대 주인의 policy host)의 차단기가 60분 넘게 열려 있으면(open·probing) Oracle 반영이 진행을 채워도
  `upstream_stalled` 경보다(재시작 대상 아님). 역할이 다른 home 으로 넘어간 뒤 남은 옛 host 차단기는 경보가 아니다.
- maintenance 감시(role-worker 재시작 판정): claims 에서 home 차단기가 열려 쉬는 동안은 저장이 없어도 멈춤으로 보지 않는다(`splitHeld`).
  오래 열림도 재시작 사유로 삼지 않는다 — 재시작은 host 네트워크를 고치지 못하고, 다시 선출된 같은 host 가 시험하기 전에 또 재시작하는 고리만 만든다.
  오래 열림은 위 관문·운영센터 경보로 사람이 본다(필요하면 maintenance 역할을 다른 home 으로 옮긴다).
- 잡 이벤트(`job:uptime-ping`): `uptime.split_applied`(제출분 반영 수), `uptime.checked`, `uptime.broad_failure_held`, `uptime.split_blocked`
  (`breakerOpen`·`unconfigured`·`fenced`), `uptime.split_clock_skew`(`skewMs`), `uptime.split_result_invalid`(`invalid`).

## 되돌리기

1. **claims → legacy**(언제든, 근거 불필요):

   ```sh
   node --import tsx scripts/ops/uptime-split.ts mode --to=legacy --from-mode=claims --expect-epoch=E \
     --operator=<이름> --reason="<사유>" --execute
   ```

   epoch+1 로 Oracle 제출은 그때부터 거부된다. 나가 있던 claim 은 TTL(180초) 뒤 만료된다. 남은 `submitted` 는 legacy 동안 그대로 있다가
   다시 claims 가 되면 첫 틱의 적용기가 `control_epoch` 로 버린다(legacy 잡은 `uptime_claims` 를 보지 않는다). 다음 틱부터 legacy 잡이 지금 방식으로 돈다 —
   `status` 의 5분 반영이 0 으로 내려가고(legacy 는 claim 장부를 쓰지 않는다) `product_health` 저장은 계속되는지(운영센터 응답 점검 칸의 6시간 밀림,
   `select max(checked_at) from product_health`) 확인한다.
2. **Oracle 만 빼기**: policy 에서 Oracle 항목을 지운다(epoch+1, 다음 claim 부터 거부) 또는 unit 을 멈춘다(TTL 뒤 회수).
3. **코드 되돌리기**: 반드시 1 을 먼저 하고 legacy 틱을 확인한 뒤, Oracle unit 을 멈추고 이전 SHA 로 재배포한다. 표(0103)는 남겨도 무해하다.

## 알려진 잔여(고치지 않음, 운영으로 다룬다)

- **claims → legacy → claims 왕복**: legacy 동안 남은 재확인 요청(confirm) 행은 다음 claims 에서 6시간 필터를 건너뛰고 맨 앞에서 다시 열린다.
  legacy 가 방금 본 제품이면 `minimum_interval` 로 보류된다(사이트 요청 1회 낭비, 이중 계산 없음). 왕복을 자주 하지 않는다.
- **혼합 버전**: maintenance 예비(mini)만 구버전인 채 claims 에서 역할을 넘겨받으면 구버전 legacy 와 Oracle 이 같은 제품을 몇 분 안에 각각 연다
  (정식 기록은 `older_observation`·`minimum_interval` 이 지켜 두 번 세지 않는다). **M3·mini maintenance 는 같은 SHA** 로 배포한 뒤 claims 로 간다.
- **PR09 raw 관측 경로의 연속 실패 리셋 의미**: `recordUptimeObservation`(gate 꺼짐)은 `resetStreak: !health?.downSince` 로 제품 수정 시각을 보지 않는다.
  legacy(PR-0a 이후)·claims(`splitResetStreak`)는 "연속 실패가 시작된 뒤 제품이 바뀌었을 때만 1부터" 다. 지금은 0103 트리거가 PR09 와 split 을
  함께 켜지 못하게 해 무해하지만, PR09 를 다시 쓰려면 이 의미를 legacy 와 맞춰야 한다. 그 경로는 비표준 HTTP 상태(999)를 raw 표 CHECK 에 그대로
  넣으려 해 기록이 실패한다는 점도 함께 맞춰야 한다.
- **Oracle 계정 권한의 남은 폭**: 0106 트리거가 둘을 닫았다 — Oracle 계정은 claim 행을 Oracle host·probe 로만 쓰고(home 으로 적힌 행은 42501,
  적용기의 `submitted_not_probe` 는 두 번째 관문으로 남는다), `operations_observations` 에는 자기 consumer 키(`uptime-consumer:uptime-consumer-*`·
  `service:maintenance:uptime-consumer-*`)만 쓴다. 남은 것은 제어 행 잠금용 `UPDATE(id)`(`dr_writer_fence`·`uptime_split_control`)다 — FOR SHARE 에 필요한
  권한이 `SELECT … FOR UPDATE` 도 허용하고 트리거·RLS 로는 가를 수 없어, 행 잠금을 문장 10초·idle 60초까지 쥘 수 있다(역할 계정과 같은 관행,
  oracle 활성화 runbook "consumer 행 범위(0106)"). products 는 claim 이 읽는 다섯 열만 읽는다(`least-privilege.sql`).
