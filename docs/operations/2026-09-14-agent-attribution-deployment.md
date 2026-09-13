# AI 기여 표기 검증 PR 병합·운영 배포

2026-09-14 KST. 사용자가 #110 → #111 → #112 순서의 검토·병합·배포를 승인했다.

## 검토와 병합

| PR | 확인 | 병합 커밋 |
|---|---|---|
| [110](https://github.com/JRVector9/nomorevibe/pull/110) | 설정·모델 선언과 committer-only 승격 제외, 심사 캐시 갱신 | 5f49eb93674996316e126cddef77799eb1d804ff |
| [111](https://github.com/JRVector9/nomorevibe/pull/111) | 변경 파일·범위·기본 브랜치 연결, 포크 전환 무효화, Aider 역할 구분 | e743d48429f9e4e797eaf42e2c47bf81d7295b2f |
| [112](https://github.com/JRVector9/nomorevibe/pull/112) | 읽기 전용 전체 보고서, 동일 정규화, 신고 분리 및 중복 제거 | 7492cf0887de85c364711d4b8dafb79e8ef1c9e1 |

각 PR 원문 diff와 독립 리뷰의 수정 후 CLEAN 결과, 최신 CI를 재확인했다. 앞 PR 병합 후 다음 PR의 base를 main으로 바꾸고 merge commit 방식으로 조상을 보존했다. 세 원격 작업 브랜치는 모두 병합 확인 후 정리했다. 로컬 작업 트리와 사용자 미커밋 Hero·디자인 파일은 보존했다.

최종 배포 커밋7492cf0의 tree는 검증한 c43f867과 동일하다. 단위957/통합613, 타입·lint·빌드 CI 통과. [병합 main CI](https://github.com/JRVector9/nomorevibe/actions/runs/34772638671)도 전체 통과한 뒤 배포했다. 문서 기록 커밋은 실행 코드 배포와 분리한다.

## 배포 결과

| 서비스 | Dokploy applicationId | 결과 |
|---|---|---|
| M3 웹 | oipo2OAnIrtcnILBCRoG2 | 새 release 응답, app/DB 정상 |
| mini 웹 | llv4rlABSJOcFauSxaHdx | 새 release 응답, app/DB 정상 |
| 수집 | AFHDBGCCY4zT9XkkcnzGd | healthy, release·실제 소스 일치 |
| 발행 | AeTaWnZbZKzzv94h7c8Vw | healthy, release·실제 소스 일치 |
| 심사 | 4RlA9EeKvtKGdR6c6AV4j | healthy, release·실제 소스 일치 |
| 유지보수 | 7OlFqQdacbyQseQM72E7b | healthy, release·실제 소스 일치 |
| 스케줄러 | uAjLU7MslLIGpORD9h6LQ | healthy, release·실제 소스 일치 |

Dokploy API로7개를02:52:16–17에 요청했다. 두 웹은 동일 release/NEXT_DEPLOYMENT_ID와 기존 공통 Actions key 구성을 유지했다. 워커는 각1개, stop-first와60초 종료 대기(기존 supervisor drain45초)를 확인했다. 변경은 선택적 JSONB 필드이므로 SQL migration은 없다. connect-agent 코드는 변경되지 않아 재배포하지 않았다.

**재시도 이력:** 첫 배포에서 publisher/reviewer가 Docker Swarm의 `No such container`로 자동 롤백했다. Dokploy는 done을 표시했으나 실제 RELEASE_TAG가 이전 값이라 발견했다. API로 두 서비스만 재배포해02:56:11/14에 Swarm update completed를 확인했다. 최종5개 워커 모두 healthy이고 detector/collector/summary/audit/review-contract 파일 SHA256이 배포 checkout과 일치한다. 모든 RELEASE_TAG는7492cf0이다.

## 운영 적용과 검증

02:57:02, `saveSettings`로 저장된 `agentEvidence.detectorVersion`만2026-09-06.1→2026-09-14.1로 변경했다. 전후 전체 설정 비교로 다른 필드 불변을 확인했다. collection enabled=true, display=false, enforceEligibility=false, reviewMode=observe, policyVersion=2026-09-06.1을 유지한다. AI 사용 인증이나 공개 AI 흔적 열을 추가하지 않았다.

02:57:08 실측: 정기 수집이 새 버전으로14 complete/4 partial 검사를 저장했고, 새 커밋 표기7개 모두 commitEvidence를 가진다. 설정·지침 관측13개는 작성 기여 확정값으로 집계하지 않는다. 표기7개는 제품7개나 실제 AI 사용7건을 뜻하지 않는다.

02:57:03 읽기 전용 전체 보고서 완료: 발행6,898개 중 구버전5,184, 미검사1,698, current12, incomplete3, failed1. 새 조건을 모두 충족한 공개 제품 기여 집계0개. 관측된 새 근거 중 공개 제품에 연결된5개는 부분 검사4개·관계 미확인1개로 제외됐다. 기존3,053개 legacy 표기에는 변경 파일 proof가 없어 제외됐다. 전체 재수집 완료나 AI 미사용으로 해석하지 않는다. 기존 큐·예산에 따라 순차 재검사된다.

실제 화면(1440/390): 홈9개→더 보기18개, 인기 목록 페이지 이동·개인 필터 정상. 제거한 AI 열/근거 보기 없음, 문서 가로 넘침 없음(기존 표 내부 가로 스크롤 유지), pageerror0. 첫 화면 측정2.433초/0.440초. 두 스크린샷을 직접 확인했다. M3/mini 직접 `/api/health` app·DB 모두ok, release7492cf0, DB latency1/2ms.

## 증거와 재확인

작업 트리 `/tmp/nomorevibe-agent-prs/.crawl-samples/`:

- attribution-deploy-before.jsonl / attribution-deploy-queued.jsonl / attribution-deploy-status-final.jsonl
- attribution-release-env.jsonl / attribution-runtime-final.jsonl / attribution-web-health.json
- attribution-detector-cutover.json (설정 저장 로그와 영수증2행)
- attribution-audit-deployed-20260914.jsonl (마지막 complete=true)
- attribution-state-after.json / attribution-state-final.json
- attribution-ui-live.json / attribution-ui-live-1440.png / attribution-ui-live-390.png

재확인 명령(임시 도구는 현재 세션에만 보존):

```sh
python3 /tmp/nomorevibe-attribution-deploy.py status
python3 /tmp/nomorevibe-attribution-runtime.py
python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/attribution-rollout-state.ts
```

보고서 재실행은 새 출력 파일명을 사용한다. 운영에서는 fixture seed나 통합 테스트를 실행하지 않는다. 재배포·설정 변경·전체 backfill은 위 읽기 전용 확인 명령에 포함하지 않는다.
