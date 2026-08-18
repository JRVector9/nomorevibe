# 남은 작업

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## D1. 카테고리 분류를 실제로 호출해 확인하기

**막고 있는 것**: `ANTHROPIC_API_KEY`. 이 머신에 키도 `ant` 프로필도 없어 한 번도 실제
호출을 못 했다.

**지금 상태**: 코드는 있고(`lib/crawl/classify.ts`) 키가 없으면 조용히 규칙 분류로 떨어진다.
즉 **키를 넣기 전까지 새로 발행되는 제품은 계속 키워드 규칙으로 분류된다.**

```
모델      claude-sonnet-5
effort    high
max_tokens 4096   (생각한 만큼도 출력 한도에서 나간다 — 작게 두면 답 전에 잘린다)
timeout   12초, 재시도 0회   (발행 잡의 틱 예산이 25초다)
출력      zod 구조화 출력으로 5개 카테고리 중 하나 + 판단 근거 한 줄
실패 시   null → 호출부가 토픽·설명 키워드 규칙으로 되돌아간다
```

### 확인할 것

한 번도 밟아보지 못한 경로가 셋이다.

1. `messages.parse()` + `zodOutputFormat`이 실제로 카테고리 enum을 강제하는지
2. `effort: high`에서 12초 타임아웃과 4096 한도가 충분한지 (실제 소요 시간·토큰을 잰다)
3. 실패 분기가 의도대로 갈리는지 — 인증 오류/한도 초과/그 밖을 로그에서 구분하는지

### 절차

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local   # .env.local은 gitignore된다

# 후보를 되돌려 재발행 (개발 DB)
#   crawl_candidates를 state='new'로, 해당 products 행을 지운 뒤
npm run job crawl-judge
npm run job crawl-publish

# 로그에서 확인
#   crawl.classified   { repo, category, reason }   ← 성공
#   crawl.classify_failed { reason: auth | rate_limit | ... }
#   crawl.classify_disabled { reason: no_api_key }  ← 키가 없을 때 한 번만
```

### 이미 알고 있는 것 (다시 재지 말 것)

키가 없어 같은 프롬프트를 다른 모델로 태워 **접근이 규칙보다 낫다는 것은 확인했다.**

| | 규칙 | codex (gpt-5.5 high) | qwen3.5-122b |
|---|---|---|---|
| Productivity | 0 | 13 | 11 |
| Dev | 9 | 11 | 7 |
| Finance | 2 | 4 | 2 |
| Design | 2 | 1 | 0 |
| Other | **19** | 3 | 4 |

- 규칙은 `Productivity`를 **한 건도 못 골랐다**. 제품 소개가 `todo`·`note` 같은 키워드를
  쓰지 않아 업무 도구가 전부 `Other`로 떨어졌다.
- 대표적 오분류: `RevealUI` — 소개에 `Payments`가 있다는 이유로 `Finance`가 됐다.
  두 모델 모두 `Productivity`(업무 운영 도구)로 바로잡았다.
- 두 모델의 일치율 75%. qwen은 32건 중 8건에서 JSON 형식을 못 지켰다 — 우리가 구조화
  출력을 강제한 이유가 여기서 드러난다.
- **개발 DB의 seeded 제품 32건은 codex 결과로 이미 백필돼 있다.** 실측 후 비교 대상으로 쓸 것.

---

## B1. 프로덕션 스케줄러 등록

**막고 있는 것**: 사용자 결정. 운영 환경(Dokploy) 변경이라 임의로 하지 않았다.

**지금 상태**: cron 진입점(`POST /api/cron/<job>`)과 로컬 배포용 스케줄러
(`scripts/scheduler.sh`, compose의 `scheduler` 서비스)는 있다. **프로덕션에는 아무것도
걸려 있지 않아 수집과 랭킹 스냅샷 갱신이 돌지 않는다.**

### 걸어야 할 것

```
*/1  * * * *   crawl-fetch     레포 조회 5000회/시간, 한 틱 30건 남짓
*/5  * * * *   crawl-judge     계산만 한다
*/5  * * * *   crawl-publish   판정 직후에 돌아야 바로 목록에 오른다
*/15 * * * *   crawl-seed      검색 30회/분, 프론티어는 한 번 차면 오래간다
*/10 * * * *   uptime-ping     같은 제품은 6시간에 한 번만 본다
0 * * * *   click-rollup       KST 일별 클릭 집계
5 * * * *   ranking-refresh    시즌 경계·쿨다운·공개 순위 스냅샷
```

`ranking-refresh`는 반드시 `click-rollup`이 끝난 뒤 실행해야 한다. 두 작업을 포함한 위
프로덕션 스케줄은 아직 등록되지 않았다.

각 호출은 이 형태다.

```bash
curl -X POST $SITE/api/cron/<job> -H "Authorization: Bearer $CRON_SECRET"
```

겹쳐 호출해도 안전하다 — 러너가 이름별 잠금을 걸어 중복 실행을 건너뛴다.

### 필요한 환경변수

| 변수 | 없으면 |
|---|---|
| `CRON_SECRET` | cron 진입점이 항상 403 |
| `GITHUB_TOKEN` | 시간당 60회라 seed·fetch가 성립하지 않는다 (`jobs.last_error`에 남는다) |
| `ANTHROPIC_API_KEY` | 카테고리가 규칙 분류로 떨어진다 (D1 참고) |
| `TRUSTED_PROXY_HOPS` | **0이면 rate limit이 전역으로 묶인다.** 프록시 뒤라면 hop 수를 맞출 것 |

### 확인

`/admin/status`의 작업 표에서 마지막 실행·성공 시각이 갱신되는지 본다. "실행 기록 없음"은
스케줄러가 아직 닿지 않았다는 뜻이고, 마지막 성공만 오래됐다면 그 아래 오류를 본다.

### 함께 해야 할 일

**배포 환경의 크롤 설정이 옛 값으로 돌고 있을 수 있다.** 설정은 데이터라 한 번 저장하면
코드 기본값을 덮는다. `/admin`이 어긋난 항목을 짚어주고 "기본값으로 되돌리기" 버튼을 둔다
(수집 스위치는 건드리지 않는다). 조직 계정 제외 해제·Codex 신호·차단 도메인·문서 생성기
목록이 그렇게 반영된다.
