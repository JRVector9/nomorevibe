# 08. 사용자·메이커 경로 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


기준: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용 점검, 테스트·EXPLAIN 미실행.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 1 · P1 0 · P2 5 · P3 6 (총 12건)
- DOM-01 (P0) 메이커 소유 확인의 저장소 id 근거가 덮어써지고 사라진다. `crawl_documents.repo_meta` 는 다시 수집하면 제자리에서 덮이고, 사실 수집의 repositoryId 는 갱신될 때마다 덮이며, 스타 관측은 7일 뒤 지워진다. 옛 id 가 남지 않으면 소유 확인의 «저장소가 바뀌었는지» 방어가 성립하지 않는다.
- DOM-02 (P2) 상세 부가 API(`/api/products/[slug]/details`)가 캐시도 복제본도 거치지 않고 주 DB 에서 `productTalk` 를 부른다. 화제 순위 하나를 얻으려고 그 자리에서 화제판 전체(`listTalk`)를 다시 계산하고, `max(last_seen_at)` 으로 social_posts 를 통째로 훑는다(주 DB 6,506회·복제본 24,866회 full scan).
- DOM-03 (P2) 등록 요청이 제품을 넣은 뒤에도 OG 그림 받기(최대 6 hop × 10초)를 기다린 다음에야 수정 키를 돌려준다. 썸네일 잡이 같은 일을 이미 하므로 요청 안에서 할 필요가 없고, 오래 걸리면 클라이언트가 응답을 놓친다.
- DOM-04 (P2) 수정 키 발급(등록·클레임 verify)이 멱등이 아니고 다시 받을 길도 없다. 응답 하나를 놓치면 그 제품은 영영 고칠 수 없다. 동시 verify 는 키를 두 번 발급하고, 메이커 업데이트는 재시도할 때마다 중복으로 쌓이며 그때마다 팔로 알림도 나간다.
- DOM-05 (P2) 메이커 등록은 저장소 중복을 보지 않는다(수집 발행은 `guardPublication` 으로 막는다). 이미 수집된 저장소를 다른 주소로 등록하면 같은 저장소의 공개 제품이 둘이 된다.

## 발견

### DOM-01 저장소 id 근거(앵커)가 제자리 덮어쓰기·7일 보관으로 사라져 소유 확인의 방어가 약해진다
- 심각도: P0 (소유자 규칙: 메이커 소유 확인의 저장소 id 근거를 잃는 경로)
- 분류: logic
- 위치:
  - `lib/me/maker-claims.ts:168-185` storedRepositoryAnchors — 주석은 «원본·관측은 지난 것까지 모두 본다»고 하지만, 읽는 세 출처 모두 «마지막 값 하나»만 갖는다.
  - `lib/crawl/repository.ts:679-690`, `:711-715` saveFetchedDocument — 새 GitHub id 는 *다른 행*에 같은 id 가 있는지만 보고, 같은 행의 옛 id 와 다르면 그대로 덮는다.
    ```ts
    if (githubId && (!previous || previous.repoMeta.id !== doc.repoMeta.id)) {
      const [existing] = await tx.select(...).where(and(sql`repo_meta->>'id' = ${githubId}`, ne(crawlDocuments.repo, doc.repo)))
      if (existing) { ...skipped; return { duplicateOf } }
    }   // ← previous.repoMeta.id 와 달라도 아래에서 그대로 덮음
    const [saved] = await tx.insert(crawlDocuments).values(values).onConflictDoUpdate({ target: crawlDocuments.repo, set: values })
    ```
  - `lib/domain/evidence/providers/github.ts:724-727`, `:767` — `/repos/{key}` 에 200 이 오면 `mapGitHubRepositoryFacts` 가 새 `repositoryId` 를 넣는다. 옛 id 와 맞추어 보지 않는다.
  - `lib/domain/products/star-observation-policy.ts:19` `retentionDays: 7`, `lib/jobs/products/star-observation.ts:223-241` — 스타 관측의 node id 근거는 7일 뒤 지워진다.
  - 다시 수집하는 길: `lib/crawl/audit-stale-recollect.ts:28`, `:182`(공개 제품의 감사 거절도 frontier 를 pending 으로 돌린다 — 주석 «수집이 원본을 덮어쓴다(saveFetchedDocument)»). 관리자 근거 재수집·reconsider 등도 같은 길을 쓴다.
- 문제: 소유 확인은 「전에 본 저장소 id 가 지금 GitHub 의 id 와 다르면 거절」에 기대는데, 근거 세 곳(수집 원본 repo_meta · 사실 수집 repositoryId · 스타 관측)이 모두 마지막 값만 남기거나 7일 뒤 지워진다. 옛 id 가 어디에도 남지 않으면 이 방어가 성립하지 않는다. 소유자 규칙(「아이디 근거 사라지지 않도록」)에 직접 어긋난다. 구체적 경로는 공개 저장소라 싣지 않았다(비공개 메모).
- 실측 근거: 코드 근거만(운영에서 일어난 사례는 확인하지 않음)
- 수정 방안(추천: 덧붙이기만 하는 앵커 표):
  1. 새 표 `repository_identity_anchors(repo_key lower, github_repo_id bigint, node_id, owner_id, source, first_seen_at, last_seen_at, unique(repo_key, github_repo_id))` 를 만든다. 지우지 않고 db-retention 에서도 뺀다. 마이그레이션 때 `crawl_documents.repo_meta->>'id'`, `product_evidence_sources.normalized_facts->>'repositoryId'`, 남아 있는 `product_star_observations.repository_id` 로 즉시 채운다(데이터를 더 잃기 전에 먼저 배포).
  2. saveFetchedDocument·사실 수집·스타 관측·claims lookup 이 id 를 볼 때마다 이 표에 넣는다(`on conflict do update set last_seen_at`).
  3. saveFetchedDocument: `previous.repoMeta.id` 가 유효하고 새 id 와 다르면 repo_meta 를 덮지 않는다. frontier 를 `skipped`(새 사유 `SKIP_REPO_REPLACED`)로 끝내고 제품을 사람 검토로 보낸다. 사실 수집도 id 가 바뀌면 `disconnected`/`repository_replaced` 로 기록하고 facts 를 덮지 않는다.
  4. `storedRepositoryAnchors` 는 이 표만 읽는다.
  - 대안: crawl_documents 에 `repo_meta_history` 열을 둔다. 그러나 출처가 셋이라 표 하나가 낫다.
- 검증:
  - 새 테스트: «같은 repo 이름에 다른 id 로 다시 수집 → repo_meta 유지·앵커 2개 → claimProducts 결과 repo_replaced».
  - 같은 조건의 사실 수집 갱신 테스트.
  - 백필 후 `select count(distinct repo_key)` 가 `crawl_documents` 수 이상인지 확인.
- 배포 주의: 마이그레이션(새 표 + 백필) 다음 crawler(fetch)·maintenance(evidence)·web 순으로 배포한다. 백필은 큰 표(crawl_documents 3.5GB)를 읽으므로 배치로 나누고 창 밖에서 돌린다.
- 확신도: CONFIRMED (덮어쓰기 세 경로와 7일 삭제를 끝까지 읽음, 옛 id 를 비교·보존하는 곳이 없음을 `rg repositoryId|replaced` 로 확인).
- 규모: M

### DOM-02 상세 부가 API 가 주 DB 에서 캐시 없이 화제판 전체를 다시 계산하고 social_posts 를 full scan 한다
- 심각도: P2
- 분류: latency
- 위치:
  - `app/api/products/[slug]/details/route.ts:35` — `detailPageData(...)` 가 publicRead/onReplica 밖에서 불린다. 그래서 `db` 는 주 DB 다(`lib/db/index.ts:59-67`).
  - `lib/domain/products/detail-page-data.ts:84-86` — `talkRank` 하나를 얻으려고 `productTalk(...)` 를 부른다.
  - `lib/social/talk.ts:311-320`
    ```ts
    const board = qualifies && ranked.some(...) ? await listTalk({ mode: "now", now }) : null;   // 캐시 없는 화제판 전체
    ...
    checkedAt: board?.checkedAt ?? await lastCheckedAt(),
    ```
  - `lib/social/talk.ts:273-275` `select max(last_seen_at) from social_posts` — 색인이 없다(`lib/db/social-schema.ts:44-46` 에는 source+external, repository_key+posted_at, posted_at 셋뿐).
- 문제: 화제 글이 하나라도 있는 제품의 상세를 열 때마다 주 DB 가 social_posts 를 full scan 한다(`lastCheckedAt`). 자격 있는 제품이면 `listTalk` 를 통째로 다시 계산한다: talkGroups 조인 + `unlistedCounts`(최근 7일 글 다시 읽기, products·crawl_candidates 조회) + starGrowths + full scan. 같은 값이 `readTalkBoard`(publicRead "list", Valkey 공유)에 이미 캐시돼 있는데 쓰지 않는다. 브라우저가 따로 부르는 `/api/products/[slug]/talk` 는 publicRead 로 감싸 복제본·30초 캐시를 쓰지만, 그 안의 productTalk 도 `listTalk` 를 캐시 없이 부른다.
- 실측 근거:
  - `pg-stats-primary.txt:31` `social_posts | 32 MB | 58287 | 6506 | 304564052` — 주 DB 에서 한 번에 약 46.8k행씩 6,506회 full scan.
  - `pg-stats-replica.txt:5` `social_posts | 24866 | 1312428112` — 복제본 24,866회, 한 번에 약 52.8k행(표 전체).
- 수정 방안:
  1. `productTalk` 의 순위는 `readTalkBoard("now", now)` 의 캐시된 entries 에서 찾는다. `listTalk` 를 직접 부르지 않는다.
  2. `checkedAt` 은 수집 잡(hn-talk·bluesky-talk·x 수신)의 마지막 성공 시각(`jobs.last_success_at`)으로 바꾼다. 꼭 `max(last_seen_at)` 이 필요하면 `social_posts(last_seen_at desc)` 색인을 둔다(추천은 jobs 표: 쓰기 비용이 없다).
  3. `detailPageData` 의 talk 읽기를 `publicRead("detail", ["talk", slug], ...)` 로 감싸 `/talk` 라우트와 같은 캐시 열쇠를 쓴다.
- 검증: 배포 전후 `pg_stat_user_tables` 의 social_posts seq_scan 증가율(주 DB 하루 약 1,160회 → 0에 가깝게), 상세 API p95, `EXPLAIN` 로 `max(last_seen_at)` 이 Index Only Scan 인지 확인.
- 배포 주의: 일반 배포(색인을 고르면 `CREATE INDEX CONCURRENTLY` 마이그레이션).
- 확신도: CONFIRMED (호출 경로·replica 경계·색인 정의를 확인함)
- 규모: S

### DOM-03 등록이 제품을 넣은 뒤 OG 그림 받기를 요청 안에서 기다린다 — 응답(수정 키)이 수십 초 늦어진다
- 심각도: P2
- 분류: async
- 위치: `lib/domain/products/register.ts:143-158`
  ```ts
  const ogUrl = extractOgImage(page.html, canonical);
  if (ogUrl) {
    const path = await cacheOgImage(ogUrl, slug).catch(...)   // mode 기본값 "interactive"
    if (path) await repo.setOgImage(slug, path);
  }
  ...
  await requestJob("product-thumbnail-refresh")...
  return ok({ slug, editToken, verifyToken });
  ```
  `lib/domain/products/og.ts:20-43`(그림이 없으면 «썸네일 잡이 나중에 채운다»), `lib/net/fetch.ts:284-296`(interactive 는 hop 마다 새 10초, 최대 5번 리다이렉트).
- 문제: 페이지 확인(fetchPage)은 «살아 있는지» 판정이라 요청 안에서 해야 한다. 그러나 OG 그림은 insert 가 commit 된 뒤의 덧붙이는 일이고, 같은 요청 끝에서 깨우는 썸네일 잡이 똑같이 채운다. 느린 이미지 서버(302 연쇄·느린 본문) 하나만 있어도 등록 응답이 페이지 확인 시간 + 최대 약 60초 늦어진다. 그 사이 스킬의 curl 이나 프록시가 끊기면 이미 commit 된 제품의 수정 키를 받지 못한다(DOM-04 로 이어짐). verify 도 파일 + 페이지 두 번(각각 최대 60초)을 기다리지만 그쪽은 판정 자체라 필요하다.
- 실측 근거: 코드 근거만
- 수정 방안: register 에서 `cacheOgImage` 를 빼고 `requestJob("product-thumbnail-refresh")` 만 남긴다. 썸네일 잡이 `og_image` 가 빈 새 제품을 먼저 고르는지 확인하고, 아니면 우선순위를 준다. 정 남기려면 `after()` 로 응답 뒤에 돌린다(다만 프로세스가 끝나면 사라지므로 추천은 잡).
- 검증: 등록 API p95(로그 `register.succeeded` 시각 - 요청 시작), 느린 og:image 를 가진 로컬 픽스처로 응답 시간 테스트, 새 제품의 og_image 가 채워지기까지 걸리는 시간.
- 배포 주의: 일반 배포(썸네일 잡 쪽 우선순위를 바꾸면 그 잡의 역할 앱도 함께).
- 확신도: CONFIRMED
- 규모: S

### DOM-04 수정 키 발급·메이커 쓰기가 멱등이 아니다 — 응답을 한 번 놓치면 그 제품은 영영 고칠 수 없다
- 심각도: P2
- 분류: logic
- 위치:
  - `lib/domain/products/register.ts:103-141` — 같은 URL 로 다시 요청하면 `duplicate`(slug 만) 가 오고 키는 없다(`:52-59`).
  - `lib/domain/products/verify.ts:84-113` — `claiming ? generateEditToken()`. 이미 verified 면 `already: true` 이고 키를 다시 주지 않는다(`:38-40`).
  - `lib/domain/products/repository.ts:768-776` markVerified — where 조건이 `verifyToken`·banned 만 본다(`claimedAt is null` 이 없다).
  - `lib/domain/evidence/maker.ts:166-187` createMakerUpdate — `dedupeKey: maker:${randomUUID()}`(줄 170), commit 뒤 `notifyNewReleases`.
  - 키를 다시 받는 길이 없다: `rg editTokenHash` 결과 쓰는 곳은 register·verify·publish 셋뿐이다. skill/SKILL.md 도 «이 응답에만 나오는 값이다»라고 적는다.
- 문제:
  1. 등록이나 클레임 verify 의 응답이 끊기면(DOM-03 의 긴 대기, 모바일 끊김, 프록시 타임아웃) 서버에는 키 해시만 남는다. 다시 시도하면 각각 «duplicate»·«already» 가 온다. 메이커가 등록한 제품은 `isUnclaimed`(source=crawler)가 아니라 클레임으로도 되찾을 수 없다. 결국 수정·삭제·근거 쓰기(profile·links·media·updates·refresh)가 모두 막히고 관리자만 풀 수 있다.
  2. 같은 제품에 verify 가 동시에 두 번 오면 둘 다 `isUnclaimed` 를 보고 키를 만든다. markVerified 가 잠금 순서대로 둘 다 적용해 뒤의 키가 앞의 키를 덮으므로, 앞 요청이 받은 키는 쓸 수 없다. `notifyMakerNewProject` 도 두 번 불린다(dedupe 로 한 줄이 되긴 한다).
  3. 메이커 업데이트를 재시도하면 같은 글이 또 생기고, `followed_release:<새 id>` 알림(즉시 메일을 고른 팔로어에게는 메일)이 또 나간다.
- 실측 근거: 코드 근거만
- 수정 방안(추천: 이미 있는 패턴 재사용):
  - 피드백(`requestId`, `lib/domain/feedback/submit.ts:33-37`)·스타(`operationId` 영수증)와 같은 `Idempotency-Key` 머리를 register·verify·updates POST 에 받는다. (키 해시, 요청 해시, 응답 본문 일부)를 24시간 보관하는 표를 두고 같은 키면 같은 응답(수정 키 포함 — 암호화 저장 또는 해당 시간 동안만)을 돌려준다. 스킬은 명령마다 UUID 를 만들어 보낸다.
  - markVerified 의 클레임 갱신에 `isNull(products.claimedAt)` 조건을 더해, 경쟁에서 진 쪽은 already 로 끝낸다.
  - 키 분실 복구: 도메인 검증을 다시 통과하면(verify 파일·메타) 키를 다시 발급하는 `POST /verify?reissue=1` 을 둔다. 소유 증명이 같으므로 보안 수준이 같다.
- 검증: 테스트 — 같은 Idempotency-Key 로 register 두 번 → 같은 slug·같은 키, 동시 verify 두 개 → 키 하나만 유효·하나는 already, 재발급 경로는 verify 파일이 맞을 때만.
- 배포 주의: 마이그레이션(멱등 표). skill/SKILL.md 와 install.sh 를 함께 갱신해야 한다(옛 스킬은 머리 없이 기존대로 동작).
- 확신도: CONFIRMED
- 규모: M

### DOM-05 메이커 등록이 저장소 중복을 보지 않는다 — 같은 저장소의 공개 제품이 둘 생긴다
- 심각도: P2
- 분류: logic
- 위치:
  - `lib/domain/products/register.ts:111-125` — `repo.insert({... repoUrl: input.repo_url ...})` 에 `beforeInsert` 가드가 없다. 중복 판정은 URL(`findByUrl`)뿐이다(`:53`, `:92`).
  - 수집 발행은 막는다: `lib/crawl/publication-guard.ts:71-77`
    ```ts
    await lockProductRepository(tx, `https://github.com/${input.document.repo}`);
    const existing = await findRepositoryProduct(input.document.repo, input.document.productUrl, tx);
    if (existing) throw new DuplicateRepositoryProductError(existing);
    ```
- 문제: 수집기가 `alice/tool` 을 `https://alice.github.io/tool` 로 이미 올렸다. 메이커가 자기 도메인 `https://tool.app` 에 같은 `repo_url` 을 달아 등록하면 URL 이 달라 «duplicate» 가 아니고, 저장소 가드도 없어 새 행이 생긴다. verify 뒤에는 둘 다 공개된다. 화제판·팔로 수 등 여러 읽기가 «같은 저장소면 id 가 작은 쪽»으로 따로 땜질하고 있다(`lib/social/talk.ts:220` 주석). 반대로 메이커가 먼저 등록한 경우에는 수집 발행이 막는다(비대칭).
- 실측 근거: 코드 근거만
- 수정 방안: register 의 insert 에 `beforeInsert: tx => { const existing = await findRepositoryProduct(...); if (existing) throw new DuplicateRepositoryProductError(existing) }` 를 걸고, 그 오류를 `duplicate`(기존 slug·status)로 돌려준다. 스킬의 409 처리가 이미 «seeded → 클레임»으로 이어진다. repo_url 이 GitHub 이 아니면 지금처럼 URL 판정만 한다.
- 검증: 테스트 «수집 제품과 같은 repo_url, 다른 URL 로 등록 → 409 duplicate(slug=수집 제품)». 운영 실측: `select repo identity, count(*) from products where status in (seeded, verified) group by 1 having count(*)>1` 로 지금 있는 중복 수를 센다.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED (의도적인 허용인지 적은 주석·테스트를 찾지 못함 — 운영 결정 확인 필요)
- 규모: S

### DOM-06 확인되지 않은 repo_url 이 메이커 알림·메이커 목록 귀속에 쓰인다
- 심각도: P2
- 분류: logic
- 위치:
  - `lib/domain/products/verify.ts:107` `if (product.status === "unverified") await notifyMakerNewProject(slug);`
  - `lib/me/notifications.ts:122-131`
    ```ts
    if (hiddenByDefault(product.category) && product.source === "crawler" && !product.claimedAt) return 0;
    const key = makerKeyOf(product.repoUrl, product.repoRenamedTo);   // 메이커가 적은 repo_url 의 GitHub 계정
    return withJobLeaseWrite(lease, (tx) => notifyFollowers({ targetType: "maker", targetKeys: [key], kind: "maker_new_project", ...
    ```
  - `lib/domain/products/schema.ts:35`, `:47` — repo_url 은 http(s) 모양만 검사한다. `lib/me/follows.ts:20-31` makerProjects 도 repo_url 계정으로 센다.
- 문제: 메이커 등록 경로는 repo_url 의 GitHub 계정을 문자열로만 받아들이고, 그 계정 기준으로 «메이커 새 프로젝트» 알림과 메이커 귀속을 만든다. 수집 제품은 발행 때 저장소 주인 id 로 확인하는 것과 비대칭이다. 구체적 경로는 공개 저장소라 싣지 않았다(비공개 메모).
- 실측 근거: 코드 근거만
- 수정 방안: `maker_new_project` 알림과 메이커 귀속(팔로 수·주인 표시)은 «repo_url 계정이 GitHub 으로 확인된 경우»에만 한다. 수집 제품(source=crawler 이고 repo_meta owner 가 repo_url 계정과 일치)이거나, 그 제품에 `product_maker_members`(github_repo_owner·repo_file) 행이 있을 때다. 메이커 등록 제품은 GitHub 운영자 확인(DOM-01 고친 뒤)이 끝난 시점에 알린다(recordOwnerMembership 안에서 dedupe 키 그대로).
- 검증: 테스트 — 메이커 등록·verify 만 하고 GitHub 확인이 없으면 maker 팔로어 알림 0, GitHub 확인 뒤 1.
- 배포 주의: 일반 배포. 이미 나간 알림 정리 여부는 운영 결정.
- 확신도: CONFIRMED
- 규모: S

### DOM-07 상세의 GitHub 스타 버튼 GET 이 볼 때마다 GitHub API 2~3번과 주 DB 쓰기 트랜잭션 3~5개를 일으킨다
- 심각도: P3
- 분류: latency
- 위치:
  - `components/product-detail/GithubStarButton.tsx:70-80` — 마운트마다 GET 한다.
  - `lib/domain/github-stars/service.ts:18-46`(`/repos/...`, 리다이렉트면 `/repositories/{id}` 를 한 번 더), `:48-55`(`/user/starred/...`), `:57-60`.
  - `lib/domain/github-user/repository.ts:83-100` claimGithubRefresh(`FOR UPDATE` + 만료 시 토큰 갱신 호출).
  - `lib/domain/github-stars/repository.ts:71-90` loadStarOperation(GET 안에서 `github_star_operations` 행을 insert·revision 갱신), `:92-104` recordStarObservation.
- 문제: GitHub 을 연결한 로그인 사용자가 상세를 열 때마다, 볼 제품마다 (사용자, 저장소) 행이 하나씩 새로 생긴다(GET 인데 쓰기가 있음). 사용자 연결 행을 `FOR UPDATE` 로 잡고, GitHub 을 차례로 부른다(대략 0.5~1.5초). 탭 여럿·빠른 탐색은 연결 행 잠금에서 줄을 선다. 상태는 방금 관측한 값(`observedAt`)이 있어도 다시 묻는다.
- 실측 근거: 코드 근거만(연결 사용자 수가 적어 지금은 부하가 작다고 본다)
- 수정 방안: GET 은 읽기 전용으로 한다(행이 없으면 만들지 않고 «모름»으로 그린다). `observedAt` 이 N분(예: 10분) 안이면 GitHub 을 부르지 않고 저장값을 준다. 저장소 id 는 `knownStarRepositoryId`·제품 근거(DOM-01 앵커 표)를 먼저 써서 `/repos` 호출을 줄인다. 쓰기(PUT)만 지금 경로를 쓴다.
- 검증: 상세 한 번 열 때 GitHub 호출 수(로그), `github_star_operations` 행 증가가 PUT 수와 같아지는지 확인.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED
- 규모: S

### DOM-08 이메일 로그인 한도의 계수 순서 — IP 한도에 걸린 요청도 이메일 몫을 센다
- 심각도: P3
- 분류: logic
- 위치: `lib/domain/accounts/repository.ts:11-19`
  ```ts
  const allowed = await rateLimit(privateRateKey("email-quarter", email), 3, 15 * 60 * 1000);
  const dailyAllowed = await rateLimit(privateRateKey("email-day", email), 10, 24 * 60 * 60 * 1000);
  const ipAllowed = await rateLimit(privateRateKey("ip", ip ?? "untrusted-peer"), 20, 15 * 60 * 1000);
  if (!allowed || !dailyAllowed || !ipAllowed) throw ...
  ```
- 문제: 세 한도(이메일 15분·이메일 하루·IP)를 모두 센 뒤에 판정한다. IP 한도에서 걸러져야 할 요청이 이메일 쪽 몫도 줄인다. 구체적 영향은 공개 저장소라 싣지 않았다(비공개 메모).
- 실측 근거: 코드 근거만
- 수정 방안: IP 한도를 먼저 보고 통과할 때만 이메일 몫을 센다. 하루 한도는 «코드를 보낸 수»로 세되, 같은 브라우저 nonce 의 재요청은 앞 챌린지가 살아 있으면 새로 보내지 않고 같은 challengeId 를 돌려준다.
- 검증: 테스트 — IP 한도 초과 요청 20개 뒤에도 그 이메일의 정상 요청이 통과한다.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED
- 규모: S

### DOM-09 바깥 클릭(/go) 한 번마다 주 DB 쓰기 3번을 리다이렉트 전에 기다린다
- 심각도: P3
- 분류: latency
- 위치:
  - `app/go/[slug]/route.ts:89` `await recordClick(slug, visitor)`
  - `lib/domain/products/clicks.ts:71-102` — `markUniqueCollectionStarted`(upsert), `rateLimit("visit:...")`(upsert), `insert click_events`.
- 문제:
  - 사용자는 리다이렉트를 기다리는데, 그 앞에 주 DB 왕복 3번이 있다.
  - `markUniqueCollectionStarted` 의 주석은 «setWhere 로 쓰지 않아 줄을 서지 않는다»고 한다. 그러나 PostgreSQL 은 `ON CONFLICT DO UPDATE ... WHERE` 가 거짓이어도 충돌한 행을 잠근다(문서 INSERT condition 절). 그래서 클릭마다 `visit_collection_state(id=1)` 행 잠금을 짧게 잡는다.
  - (slug, visitor) 마다 rate_limits 행이 하나씩 늘어난다(click-rollup 이 하루 뒤 지운다).
- 실측 근거: 코드 근거만(느린 문장 목록에는 없다 — 문장마다 0.5초 아래)
- 수정 방안:
  - 수집 시작 여부는 프로세스 메모리에 한 번 기록하면 다시 쓸 필요가 없으므로 이후 호출을 건너뛴다.
  - 중복 제거는 `click_events` 에 `(slug, visitor_hash, floor(epoch/600))` 유니크 열쇠를 두고 `insert ... on conflict do nothing` 한 문장으로 끝낸다. 그러면 rate_limits 행 증가도 없어진다.
  - 기록은 `after()` 로 응답 뒤에 해도 된다(세는 쪽이 서버라는 성질은 그대로다).
- 검증: /go TTFB, 클릭당 DB 문장 수(pg_stat_statements), rate_limits 행 수 추이.
- 배포 주의: 유니크 열쇠를 쓰면 마이그레이션(click_events 열·색인 CONCURRENTLY). /go 는 #968 과 같은 파일이므로 병합 순서를 맞춘다.
- 확신도: CONFIRMED (잠금 동작은 PostgreSQL INSERT 문서 기준. 이 저장소의 Next 문서와는 관계없음)
- 규모: S

### DOM-10 slug 고르기가 `slug LIKE 'base-%'` 라 기본 collation 이 C 가 아니면 products 를 full scan 한다
- 심각도: P3
- 분류: inefficiency
- 위치:
  - `lib/domain/products/repository.ts:682-697` nextAvailableSlug — `or(eq(products.slug, base), like(products.slug, \`${base}-%\`))`.
  - 호출: `register.ts:109`, `lib/crawl/publish.ts:219`.
- 문제: btree 유니크 색인은 collation 이 C 이거나 `text_pattern_ops` 일 때만 LIKE 접두 검색에 쓰인다. 이 저장소의 CHECK 들이 일부러 `COLLATE "C"` 를 붙이는 것(`drizzle/0090_*`)으로 보아 DB 기본 collation 은 C 가 아닐 가능성이 높다. 그러면 등록·발행마다 products(1.4GB 중 heap 부분)를 seq scan 한다. 이름이 흔하면("app") 수천 개 slug 를 앱으로 가져온다.
- 실측 근거: `pg-stats-primary.txt:15` products seq_scan 984,928회(원인은 여러 곳이라 이 문장의 몫은 미확인). 느린 문장 목록에는 없다.
- 수정 방안: `slug collate "C" >= ${base} and slug collate "C" < ${base}||'.'`(점은 하이픈 다음 글자) 같은 범위 조건과 `products(slug text_pattern_ops)` 색인 중 하나를 쓴다. 추천은 색인 없이 «base 가 비면 base, 아니면 `base-<짧은 무작위>`»로 한 번에 넣고 유니크 위반 시 재시도하는 방식(이미 재시도 루프가 있다).
- 검증: `SHOW lc_collate`, `EXPLAIN` 에서 Seq Scan → Index Scan, 등록 지연.
- 배포 주의: 일반 배포(색인을 고르면 CONCURRENTLY).
- 확신도: PLAUSIBLE (운영 DB collation 과 EXPLAIN 확인 필요)
- 규모: S

### DOM-11 공개 쓰기 입구의 작은 검증 결함 묶음 — 500·로그 범람·상한 경주
- 심각도: P3
- 분류: non-standard
- 위치:
  - `app/api/products/[slug]/takedown/route.ts:32-33` + `lib/domain/products/takedown.ts:66` — `{"reason": 5}` 나 본문 `null` 이 오면 `reason?.trim` TypeError 또는 `parsed.reason` TypeError 로 500 이 된다(zod 없음).
  - `lib/domain/products/schema.ts:39` `url: z.string().min(1)`(상한 없음) + `register.ts:41` `logger.warn(..., { rawUrl: input.url })` — 수 MB 짜리 url 이 그대로 로그에 남는다.
  - `lib/domain/products/intro-requests.ts:47-55` — 확인 전 요청 상한(20)을 세고 넣기를 잠금 없이 해, 동시 요청이 상한을 넘긴다.
  - `lib/domain/products/repository.ts:720-721` update — 세대 잠금에 실패(삭제와 경합)하면 조용히 return 하고 PATCH 는 `updated: true` 를 돌려준다.
- 문제: 각각 영향은 작다. 다만 공개 무로그인 입구라 500·로그 범람이 운영 경보와 로그 저장소를 흐린다.
- 실측 근거: 코드 근거만
- 수정 방안: takedown 본문은 zod(`reason: z.string().max(500).optional(), kind: ...`)로 받는다. registerSchema `url` 에 `.max(2048)` 을 걸고 로그에는 앞 200자만 남긴다. intro 상한은 제품 advisory lock 안에서 센다. update 는 잠금 실패 시 `not_found` 를 돌려준다.
- 검증: 각 경우의 라우트 테스트(400/404 기대).
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED
- 규모: S

### DOM-12 메이커 미디어(/api/media/[hash])가 요청마다 Postgres bytea 를 읽고 sharp 로 다시 워터마크·인코딩한다
- 심각도: P3
- 분류: inefficiency
- 위치:
  - `lib/domain/media/http.ts:8-40` — `storage.get` 다음 매번 `sharp(...).composite(...).webp()`.
  - `app/api/media/[hash]/route.ts:1-6`.
- 문제: 같은 그림을 요청마다 DB 에서 읽어 다시 인코딩한다(웹 CPU·주 DB 대역폭). og-cache 처럼 프로세스 안 사본(VariantCache)이 없다. `cache-tag` 가 없어 제품이 내려가도 엣지에서 지울 수 없다(10-13 문서가 짚은 미결과 같음 — 보강). Cloudflare 가 `/api/media/*` 를 캐시하는 규칙이 있는지는 코드에서 알 수 없다.
- 실측 근거: 코드 근거만
- 수정 방안: 워터마크한 결과를 저장할 때 한 번 만들어 둔다(`product_media` 처리 잡). 아니면 og-cache 와 같은 VariantCache + `cache-tag: p-<slug>` 를 쓴다. 버킷(MinIO, #960) 이전 대상에 포함한다.
- 검증: 미디어 요청당 처리 시간, CF 캐시 적중률(`cf-cache-status`).
- 배포 주의: 일반 배포.
- 확신도: PLAUSIBLE (CF 캐시 규칙·실제 트래픽 확인 필요)
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1 저장소 신원(앵커) 표 하나로 소유 확인·중복 판정·메이커 귀속을 묶는다
- 지금 구조: 저장소 id 근거가 crawl_documents.repo_meta(제자리 덮어쓰기), product_evidence_sources.normalized_facts(덮어쓰기), product_star_observations(7일) 셋에 흩어져 있다. 소유 확인(`storedRepositoryAnchors`)·수집 중복(`findRepositoryProduct`)·메이커 귀속(`makerKeyOf` 이름 문자열)이 서로 다른 규칙으로 읽는다.
- 바꿀 구조: `repository_identity_anchors`(덧붙이기 전용, 보관 정리 제외)를 단일 근거로 둔다. 쓰는 곳은 수집·사실 수집·스타 관측·claims lookup(같은 helper `recordRepositoryAnchor(tx, key, fact, source)`). 읽는 곳은 claims·발행 중복·메이커 귀속·repo_replaced 감지.
- 얻는 것: P0(DOM-01) 해소. 저장소 교체를 한 곳에서 감지해 제품을 사람 검토로 보낼 수 있다. claims 의 3쿼리(그중 crawl_documents 3.5GB 표 조회)가 앵커 표 색인 조회 1번으로 줄어든다.
- 옮기는 순서: ① 표 + 백필 마이그레이션(가장 먼저 — 데이터 손실을 멈춘다) ② 쓰기 helper 를 수집·사실 수집·스타 관측에 끼운다 ③ claims 읽기 전환 ④ saveFetchedDocument·사실 수집의 «id 가 다르면 덮지 않음» ⑤ 발행 중복·메이커 귀속 전환.
- 위험: 백필 중 큰 표 읽기(창 밖, 배치). ④ 때문에 정상적인 «삭제 후 같은 주인이 다시 만든 저장소»도 사람 검토로 가므로 관리자 처리 화면이 필요하다.

### S2 스킬·메이커 쓰기 API 공통 Idempotency-Key 층
- 지금 구조: 피드백은 requestId, 스타는 operationId 영수증, 나머지(register·verify·updates·media·links·profile)는 멱등 장치가 없다. 수정 키는 응답 한 번에만 나온다.
- 바꿀 구조: `withIdempotency(route, { scope: slug|"register" })` 래퍼와 `api_idempotency(key_hash, scope, request_hash, status, response_sealed, expires_at)` 표. 수정 키가 든 응답은 secret-box 로 봉해 24시간 보관한다.
- 얻는 것: DOM-04 해소. 스킬의 «타임아웃 → 재시도»가 안전해진다. 라우트마다 손으로 쓴 재전송 처리를 한 곳으로 모을 수 있다(피드백·스타는 나중에 옮겨도 된다).
- 옮기는 순서: 표 → 래퍼 → register·verify → updates → skill/SKILL.md 갱신.
- 위험: 봉한 응답 보관 기간 동안 키가 DB 에 있다(암호화·짧은 TTL·탈퇴/삭제 시 함께 지움).

### S3 화제(talk) 읽기를 «캐시된 판 1개 + 파생»으로
- 지금 구조: listTalk·productTalk·talkGroups 가 각자 social_posts 를 읽는다. 상세 API 는 주 DB 에서 캐시 없이 읽는다.
- 바꿀 구조: `readTalkBoard`(publicRead list, Valkey 공유) 하나만 DB 를 읽는다. 상세 순위는 그 판의 `Map<productId, rank>` 에서, checkedAt 은 jobs 표에서 가져온다. productTalk 의 글 목록만 repository_key 색인 조회로 남긴다.
- 얻는 것: social_posts full scan 하루 약 5,500회(주 DB + 복제본, 근거 파일 기준)가 판 갱신 주기(30초)당 1회 수준으로 준다. 상세 API 에서 주 DB 읽기가 빠진다.
- 옮기는 순서: lastCheckedAt 교체 → productTalk 의 순위 소스 교체 → detailPageData 캐시 감싸기.
- 위험: 순위가 최대 30초 늦다(이미 /talk 화면이 같은 지연을 받아들이고 있다).

### S4 요청 경로의 덧붙이는 일은 잡·발송함으로
- 지금 구조: 등록의 OG 그림, verify 뒤 메이커 팔로어 알림, 업데이트 뒤 팔로어 알림, /go 클릭 기록이 요청 안에서 await 된다.
- 바꿀 구조: 이미 있는 썸네일 잡·email outbox·notification 잡 패턴으로 넘긴다(commit 과 같은 트랜잭션에 «할 일» 한 줄 → 워커).
- 얻는 것: 등록 p95 에서 OG 몫(최대 약 60초)이 빠지고, verify·update 응답도 짧아진다. 실패가 «로그 한 줄»이 아니라 재시도되는 행이 된다.
- 옮기는 순서: OG(DOM-03) → /go 기록(DOM-09) → 알림.
- 위험: 알림이 몇 초~분 늦다.

## 확인했지만 문제 아님

- rate limit 저장 위치: Postgres 한 문장 upsert라 웹이 2대여도 한도 하나(`lib/rate-limit.ts:16-45`). 프로세스 메모리는 GitHub 답 캐시(`claimAnswers`)뿐이고 한도가 아니다.
- 메이커 삭제(`removeProductAndEvidence`, `repository.ts:829-891`)는 crawl_documents 를 지우지 않고 `crawl_candidates.published_slug` 만 푼다. db-retention 의 repo_meta 줄이기는 `id·node_id·full_name·owner(login·id·node_id·type)` 를 남긴다(`lib/operations/db-retention.ts:41-43`). crawl_documents 를 지우는 코드는 격리된 replay DB 뿐이다(`pipeline-replay-fixed-input-repository.ts:180`의 `replay_database_not_empty` 확인).
- 저장소 주소를 바꾸면 GitHub 운영자 확인을 같은 트랜잭션에서 푼다(`repository.ts:738-745`). recordOwnerMembership 은 GitHub 을 읽는 사이 repoUrl 이 바뀌었는지 잠금 안에서 다시 본다(`maker-claims.ts:267-270`).
- verify 가 페이지를 읽는 사이 내려진 차단: markVerified 가 세대 잠금 + `ne(status,'banned')` + verifyToken 조건으로 막는다(`repository.ts:765-777`).
- 이메일 발송함 멱등: dedupe_key 유니크 + 잡을 때 다음 시도 시각을 먼저 적음 + Resend `Idempotency-Key: nmv-email-<id>`, 하루 지난 줄은 닫음(`lib/me/email-outbox.ts:196-221`, `:301-322`). 주간 요약은 `digest:<user>:<KST ISO 주>` 유니크(`:65-74`, `periodContaining` 은 KST 월요일 기준).
- 웹훅: 원문 바이트 HMAC + timingSafeEqual, delivery id 유니크 + payload 해시 비교로 재전송 충돌을 감지한다. 해지성 이벤트만 즉시 반영하고 회복성 이벤트는 reconcile 이 API 로 다시 확인해 순서 뒤바뀜에 강하다(`lib/domain/github-webhooks/verify.ts:57-109`, `receive.ts:58-74`).
- 써봤어요 동시성: 제품 advisory lock 안에서 읽고 고르고 쓰고, 부분 유니크 색인 두 개로 한 번 더 막는다. 한도 증가는 같은 TX 라 실패하면 되돌려진다(`lib/domain/reactions/repository.ts:76-91`, `:150-223`). KST 하루 변경 한도(`contract.ts:140-143`).
- 팔로·저장의 상한(500)은 계정 행 FOR UPDATE 로 줄을 세운다(`lib/me/follows.ts:42-57`). 의견은 requestId 멱등 + 작성자 advisory lock(`feedback/submit.ts:27-54`). 메이커 답장은 대상별 advisory lock(`lib/me/maker.ts` upsertMakerReply).
- OAuth: state·browser nonce 해시 + PKCE + 한 번만 consume(`github-user/repository.ts:24-31`). refresh 토큰 갱신은 30초 lease 와 revision CAS(`:83-106`), 갱신 호출 상한은 8~10초(`credentials.ts:21-25`).
- 로그인 코드: 8자리, 챌린지마다 5회, 이메일 잠금 아래 FOR UPDATE, 틀린 시도는 return 으로 commit(`accounts/repository.ts:50-94`).
- 열린 리다이렉트: 로그인·GitHub·설치 후 돌아가는 곳은 `safePublicReturnUrl` 의 공개 화면 목록만 허용한다(`lib/i18n/routing.ts:56-74`). `siteOrigin` 은 NEXT_PUBLIC_SITE_URL 이 먼저라 Host 머리 주입이 없다.
- SSRF: 등록·verify·OG 는 assertPublicUrl + 연결 시점 DNS 재검사 + 리다이렉트마다 재검사(`lib/net/fetch.ts:204-221`).
- 알림 메일 끄기 열쇠는 HMAC 서명 + 글자 그대로 비교(`lib/me/unsubscribe.ts:22-35`). 수정 키는 192비트 무작위 + SHA-256 해시 저장(`lib/tokens.ts`). 해시 문자열 비교의 타이밍은 실용적인 공격이 아니다.
- 서버 분석 이벤트는 `after()` 로 응답 뒤 1.5초 상한, 던지지 않음(`lib/analytics/server.ts:210-235`).
- 클릭 일별 굴리기: 최근 3 KST 일을 매번 덮어쓰고(멱등), 35일 지난 원천은 같은 TX 에서 일별 값으로 보존한 뒤 지운다. KST 날 경계에 맞춰 잘라 같은 날이 두 번 들어가지 않는다(`clicks.ts:332-413`).
- 메이커 확인 검색의 색인: 식이 `products_listed_owner_idx`·`products_repository_identity_idx`·`products_renamed_to_idx` 정의와 글자까지 같다(`owner-key-sql.ts:9-10`, `drizzle/0108_mypage.sql:187-191`, `drizzle/0043`). idx_scan 0 은 5.6일 동안 확인 요청이 없었던 것으로 본다.

## 범위 밖·못 본 것

- `lib/domain/github-installations/authorization.ts`·`credentials.ts` 의 앱 설치·토큰 교환 세부, `lib/domain/feedback/github/*`(이슈 전달 outbox·reconcile)는 큰 흐름만 보고 줄 단위로는 읽지 않았다.
- `lib/social` 수집기(x-collector·bluesky-talk-source·hn-talk-source)의 외부 호출·재시도, `lib/news/normalize.ts`·`localization-*` 는 훑기만 했다.
- `lib/analytics` 클라이언트 쪽(dom·runtime·consent)은 DB 와 무관해 보지 않았다.
- `/api/og-cache`·상세 공개 HTML·공개 목록 API(product-cards·product-summaries·browse-counts)·anti-scrape 관문은 공개 웹 구역으로 보고 깊이 보지 않았다.
- DOM-01 의 crawl_documents 덮어쓰기는 수집 구역(saveFetchedDocument)과 겹친다. 오케스트레이터가 중복을 정리해야 한다.
- 운영 DB 의 collation(DOM-10), Cloudflare 캐시 규칙(DOM-12), 현재 같은 저장소 중복 제품 수(DOM-05)는 실측하지 않았다. 테스트·EXPLAIN 은 돌리지 않았다(공통 지침).
