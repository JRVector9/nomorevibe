# 번역·후처리 차선 남은 일 목록

이 차선은 코드와 시험만 다룬다. 운영 DB 쓰기·원격 SSH·배포·push는 하지 않는다.
근거는 `docs/CODEX_HANDOFF.md`의 2026-10-27 23:07 KST 관측이다.

| 단계 | 당시 관측 |
| --- | --- |
| product-tagline-ko | 대기 654, 수동 1,099, upstream_stalled, too_long·name_lost 품질 실패 반복 |
| reason-translate | 대기 10,964, no_progress |
| product-search-profile | 대기 15,511, upstream_stalled |

마지막 갱신: 2026-10-29 21:40 KST. 브랜치 `xaegis/5928edc4`에 로컬 커밋만 했다. push와 배포는 하지 않았다.

## 공통 원인: 결과를 모르는 요청이 대기열 머리를 막았다

capacity의 member·logical fence(`lib/llm/capacity-repository.ts` `requestSlot`)는
결과를 모르는 요청(`dispatched`·`indeterminate`)에 묶인 대상이 들어간 새 요청을 늘 `deferred`로 돌려보낸다.
그런데 세 선택기는 그 대상을 계속 머리로 골랐다.
- reason-translate는 최신 사유 넷을 골랐다.
- tagline-ko는 새 제품·홈·스타 순서로 골랐다.
- search-profile은 안 지은 것 가운데 id가 큰 것부터 골랐다.

그래서 매 틱이 `ModelCapacityDeferredError`로 끝났다. 기록은 0건이었고, 오류가 없으면 no_progress, 기존 실패 행이 있으면 upstream_stalled로 보였다.
handoff에 남은 `reason-translate indeterminate1`(m3group1)이 이 상황과 맞는다.
`indeterminate`는 운영에서 회수하기 전까지 풀리지 않는다.

`lib/llm/capacity-selection-fence.ts`를 추가했다. 세 선택기는 이제 그런 대상만 건너뛰고 뒤의 일을 한다.
같은 대상은 다시 보내지 않으므로 중복 호출을 막는 장치는 그대로다.
대기·예약 행은 TTL로 풀리고 자기 것은 재개 경로가 이어받으므로 빼지 않는다.

## 한 일

### A. product-tagline-ko (커밋 aff42414)

- **원인 1: 원문이 번갈아 바뀌었다.** 예전 `koreanTaglineSource`는 마지막 실패가 too_long·empty일 때만 앞 문장을 보냈다.
  그래서 too_long 뒤에는 앞 문장을 보내 name_lost가 났고, 그다음에는 다시 전체를 보내 too_long이 났다.
  같은 두 실패가 한도까지 되풀이됐다.
  - 고침: 같은 원문에서 품질 거절이 한 번이라도 있었으면(`qualityRejections > 0`) 계속 앞 문장을 보낸다.
    선택·묶음 복원·회복 선택기가 `qualityRejections`를 싣고, native 재진입 검증(`koreanMember`)도 이를 비교한다.
- **원인 2: 게이트웨이 실패는 끝없이 재시도됐다.** invalid_output·http_5xx·timeout은 품질 거절로 세지 않았다.
  그래서 같은 대상이 같은 실패로 하루 간격까지 늘려 가며 끝없이 다시 섰다.
  - 고침: 같은 원문의 총 시도에 `MAX_ATTEMPTS = 12` 상한을 두었다. 공통 술어 `koreanQueuePredicates.allowance` 하나에 넣었으므로 선택, 운영 집계(blocked), native 재검증이 같은 기준을 쓴다.
  - 진척 `gaveUp`·`failed`도 같은 상한을 쓴다.
  - 간격이 5분부터 두 배씩 늘어 하루에서 멈추므로, 12번째 시도까지 약 3.8일이 걸린다.
- **원인 3: 혼자 보낸 소개의 invalid_output도 품질로 세지 않았다.**
  - 고침: `rejected:invalid_output`으로 기록해 품질 한도(4회, 홈은 6회)에 닿게 했다. 묶음의 invalid_output은 누구 탓인지 몰라 그대로 둔다.
- **원인 4: 결과 모를 요청이 머리를 막았다.** 위 공통 원인과 같다.
  - 고침: `pendingKoreanTaglines`와 `pendingKoreanTaglineRecovery`가 그런 대상을 건너뛴다.

### B. reason-translate (커밋 214c1105)

- **무진척 경보의 원인:** 위 공통 원인이다. 경보 자체는 실제 정체를 맞게 보여 줬다. 처리량이 0이었기 때문이다.
  정체의 원인은 대상 선택이었다.
  - 고침: `untriedTranslations`와 `retryableTranslations`가 `ko:<hash>`가 결과 모를 요청에 든 사유를 건너뛴다.
- **두 번째 굶김:** 틱마다 '밀린 실패'부터 시작했다. 그 실패 묶음이 또 실패해 틱을 접으면 처음 보는 글이 차례를 얻지 못했다.
  - 고침: 번갈아 가는 차례를 틱을 넘어 잇는다. 기준은 프로세스 안이다.

### C. product-search-profile (커밋 a047e049)

- **불공정 1: 오래된 대상이 굶었다.** 우선순위 줄은 '안 지은 것 → 한 줄 소개 → 갱신, 같으면 id 큰 것'이었다. 이 줄만 보니 새 제품이 계속 앞에 섰다.
  안 지은 것이 1만5천 건 쌓인 동안 오래된 제품과 실패 재시도·갱신은 차례를 얻지 못했다.
  - 고침: 12건 묶음 가운데 4건을 할 일이 된 시각(`READY_SINCE`)이 가장 이른 것부터 채운다. `READY_SINCE`는 운영 진척의 식과 같고, 갱신 대기만 감사 시각(`REFRESH_SINCE`)으로 센다.
  - 순서는 우선순위 둘, 오래 기다린 것 하나로 번갈아 둔다(`interleaveProfileTasks`).
- **불공정 2: 실패한 대상이 자리를 독점할 수 있었다.**
  - 실패하면 재시도 시각이 할 일이 된 시각이 되어 뒤로 간다. 그래서 같은 실패가 오래 기다린 몫을 계속 차지하지 못한다.
  - 결과 모를 `text:profile:<id>` 요청에 묶인 제품은 고르지 않는다.
  - 한 틱 안에서 이미 집은 제품은 다시 고르지 않는다. 적지 못하고 돌아온 머리가 같은 조회를 맴돌지 않게 하려는 것이다.

### D. 시험

| 범위 | 이전 | 지금 |
| --- | --- | --- |
| 단위 vitest(차선 관련 20→21파일) | 296 | 304 |
| 통합 vitest(로컬 Postgres, 차선 관련 9파일) | 111 | 116 |

- 새 시험
  - 원문 번갈음 회귀 시험. 예전 규칙으로 되돌리면 실패하는 것을 확인했다.
  - 게이트웨이 실패 시도 상한, 혼자 보낸 invalid_output 품질 계수.
  - 결과 모를 요청이 있어도 이웃 대상이 계속 처리되는지 세 단계 모두 확인하는 시험.
  - search-profile 오래 기다린 몫과 실패 순환 시험, `interleaveProfileTasks` 단위 시험, reason 차례 잇기.
- 바꾼 기존 시험
  - 이 변경이 고친 동작을 고정하던 기대값이다.
  - `unknown`이면 잡 전체가 deferred였던 것이 이제 completed다. 다만 같은 대상은 다시 POST하지 않고 원래 행은 그대로다.
  - attempts 30인 게이트웨이 실패가 ready였던 것은 이제 blocked다.
  - '새 제품 13건에 밀려 묶음 밖' 고정값은 이제 '더 오래된 새 제품'으로 바꿔 두었다.
- 정적 검사
  - 바꾼 파일 eslint: 오류 0. 경고 1건은 기존 `tests/integration/text-profile-capacity-dispatch.test.ts`의 `_id`다.
  - `npx next typegen` 뒤 `tsc --noEmit`: 오류 0.
- 정책상 전체 unit·전체 DB·종합 시험은 돌리지 않았다. AGENTS.md에 따라 통합 단계에서 돌린다.

## 남은 일

1. **배포 뒤 운영 확인** (아래 READ ONLY SQL).
   - 배포하는 순간 같은 원문으로 12회 이상 시도한 tagline-ko 실패 행이 `blocked`(수동)로 옮겨진다. 그래서 수동 수가 늘고 대기 수가 준다.
   - 배포 전에 SQL 2로 몇 건이 옮겨질지 미리 센다.
2. **capacity 정체를 no_progress와 구분해 표시하기.**
   - 결과 모를 요청이 group·pool 자리를 모두 차지하면, 이 변경 뒤에도 잡은 `deferred(model_capacity)`로 끝나고 경보는 no_progress다.
   - 실제 정체이므로 경보는 맞다. 다만 원인 표시는 `lib/operations/worker-progress.ts`의 공통 분류를 바꿔야 해서 이 차선에서 하지 않았다.
3. **reason-translate에는 재시도 상한이 없다.** 지금은 최대 하루 간격으로 끝없이 재시도한다. tagline-ko와 같은 상한을 둘지 결정이 필요하다.
4. **product-translate에도 같은 머리 막힘 구조가 있다**(`productTranslationFence`). 이번 세 단계 범위 밖이라 고치지 않았다. 같은 fence 함수를 쓰면 고칠 수 있다.
5. **search-profile 경보와 선택 기준의 차이.** 갱신 대기의 '가장 오래된 나이'를 경보는 `updated_at`부터 세고, 선택은 감사 시각부터 센다. 그래서 경보가 더 길게 보일 수 있다. 맞추려면 `text-stage-progress.ts`·`text-progress.ts`를 같이 바꿔야 한다.

## 막힌 일

- **GPT-OSS native 프롬프트의 길이 지시가 검사와 어긋난다.**
  - 프롬프트는 "60자 안팎, 길면 줄인다"이고, 검사는 80자 하드 한도와 이름 보존이다. 이 어긋남이 too_long·name_lost의 바탕 원인 중 하나다.
  - 그러나 native wire는 `tests/translation-model-prompts.test.ts`가 고정한 바이트이고, serving contract의 `totalTokenBound`와 함께 측정된 계약이다. 바꾸려면 운영자가 계약을 다시 재고 정해야 한다.
  - 이번에는 결정적 코드(원문 줄이기·상한)로만 고쳤다.
- **운영 DB를 직접 잴 수 없다.** 이 차선에서는 운영 DB 쓰기와 원격 SSH가 금지돼 있다. 그래서 배포 전후 수치를 직접 재지 못했다(측정 없음).
- **unknown(indeterminate) 회수.** 운영 절차의 일이고 일반 배포와 별도다(AGENTS.md).

## 배포 뒤 운영에서 확인할 READ ONLY SQL

모두 `BEGIN READ ONLY; SET LOCAL statement_timeout = '5s'; … ROLLBACK;` 안에서 돌린다.

```sql
-- 1. 세 단계의 결과 모를 요청. 이 대상들만 건너뛰고 나머지는 진행해야 한다
SELECT route_id, state, count(*) AS requests, min(updated_at) AS oldest
FROM model_capacity_requests
WHERE state IN ('dispatched','indeterminate')
  AND route_id IN ('reason-translate','product-tagline-ko','product-search-profile')
GROUP BY 1, 2 ORDER BY 1, 2;

-- 2. tagline-ko: 시도 상한(12)에 닿아 blocked로 옮겨지는 현재 원문 실패(배포 전에도 같은 수)
SELECT k.error_code, count(*) AS rows
FROM product_korean_taglines k JOIN products p ON p.id = k.product_id
WHERE p.status IN ('seeded','verified') AND k.source_tagline = p.tagline
  AND k.error_code IS NOT NULL AND k.attempts >= 12
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- 3. tagline-ko: 최근 30분 결과. 성공이 다시 나오고, 품질 실패가 사유별로 고르게 줄어야 한다
SELECT CASE WHEN k.error_code IS NULL THEN 'done' ELSE k.error_code END AS outcome, count(*)
FROM product_korean_taglines k
WHERE k.updated_at > now() - interval '30 minutes'
GROUP BY 1 ORDER BY 2 DESC;

-- 4. reason-translate: 최근 15분 처리량. done이 0보다 커야 no_progress가 풀린다
SELECT status, count(*)
FROM text_translations
WHERE target_lang = 'ko' AND updated_at > now() - interval '15 minutes'
GROUP BY 1;

-- 5. product-search-profile: 최근 30분 생성 수와 가장 오래 기다린 대상의 나이(시간)
SELECT
  (SELECT count(*) FROM product_search_profiles WHERE generated_at > now() - interval '30 minutes') AS generated_30m,
  (SELECT extract(epoch FROM now() - min(CASE WHEN sp.product_id IS NULL THEN p.created_at
     WHEN sp.error_code IS NOT NULL THEN greatest(sp.updated_at, sp.retry_at)
     WHEN sp.needs_refresh THEN sp.updated_at ELSE sp.updated_at + interval '30 days' END)) / 3600
   FROM products p LEFT JOIN product_search_profiles sp ON sp.product_id = p.id
   WHERE p.status IN ('seeded','verified')
     AND (sp.product_id IS NULL OR (sp.error_code IS NULL AND (sp.needs_refresh OR sp.updated_at < now() - interval '30 days'))
       OR (sp.error_code IS NOT NULL AND (sp.retry_at IS NULL OR sp.retry_at <= now())))) AS oldest_ready_hours;
```

- SQL 5의 `oldest_ready_hours`는 배포 뒤 몇 시간 동안 줄어드는 쪽이어야 한다. 오래 기다린 몫이 틱마다 4건씩 집기 때문이다.
- 실패 재시도 상한(`attempts < 5`, 공급자 오류 예외)은 SQL에서 생략했다. 그래서 상한을 넘은 행까지 포함해 조금 길게 보일 수 있다.
- 잡 로그에서도 확인한다. `job.deferred reason=model_capacity`가 세 잡에서 매 틱 반복되지 않아야 한다. 결과 모를 요청이 자리를 모두 차지한 경우는 예외다(남은 일 2).
