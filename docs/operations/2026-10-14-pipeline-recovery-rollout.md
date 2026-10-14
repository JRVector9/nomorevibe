# 수집·검수 개선과 관리자 크롤러 활동 — 운영 배포 완료

2026-10-14, runtime `9baf31ab5c48d0104c913e53299b776cbd106679`을 M3·mini의
13개 앱/18개 컨테이너에 배포했다. migration0076과 실제 실행 소스·이미지·DB·양 웹·관리자
검증을 완료했다. 최종19단계 실행시간의 합계는277.03초다. 단계 사이 orchestration과 코드 수정·CI·이전 마이그레이션 대기는 포함하지 않는다.

## 적용 범위와 사용자 상태

수집 복구·유입 제어·근거 수집 부분 재개/캐시·작업 줄 감시·한국어 소개 품질 거절 카운터와
관리자 `크롤러 활동` 탭을 적용했다. 구현 범위와 회귀는
[구현 보고서](2026-10-14-pipeline-recovery-implementation.md),
[설계 재검토](2026-10-14-pipeline-design-reaudit.md)에 기록돼 있다.

[관리자 크롤러 활동](https://m3ultra.tail02799e.ts.net/admin/status?tab=crawlers)에서
13개 수집기, 주·예비 인스턴스와 작업 줄, 각 수집기의 마지막 저장 회차·오류·재시도·중단·
미측정 대기를 확인한다. 최근 실행은 저장된 직전 회차이며 전체 과거 로그로 해석하지 않는다.
기존 조회를 재사용하고 원시 cursor/error/detail/토큰을 새 투영에 전달하지 않는다.

소개 검수는 사용자 요청대로2100-01-01·미임대 상태를 유지했다.
X는 공식API 수동 파일럿이며 관리자에도 자동 수집 안 함으로 표시한다. 로컬 소량 테스트의
실제2요청 HTTP200·10개 게시물·공개 지표6종을 확인했으나 상시 social role/lease·일일 예산·
공개 HOT 필터는 후속 구현이다. 운영에 X 토큰을 추가하지 않았다. Threads는 가능성 조사까지다.

## 커밋·CI·실제 배포 증거

[PR416](https://github.com/JRVector9/nomorevibe/pull/416)은 관리자와 수집 개선을,
[PR417](https://github.com/JRVector9/nomorevibe/pull/417)은 모니터 집계 SQL 최적화를 정상 병합했다.
최종 PR CI38563244180과 [main CI38563927498](https://github.com/JRVector9/nomorevibe/actions/runs/38563927498)의
quality·통합3shard·필수check가 모두 성공했고 main의 양 이미지 발행도 성공했다.
문서만 바뀐 후속 main 커밋은 새 이미지를 만들지 않으며 runtime SHA와 구별한다.

| 확인 | 실제 결과 |
|---|---|
| 13앱·18컨테이너 | 모두 Dokploy done, 동일 runtime SHA, 실제 ready, 복제본 일치 |
| shared8 | immutable worker/web digest와 실행 컨테이너 일치 |
| source5 | GitHub provider/main 보존, 각532개 runtime 파일 hash 일치; scheduler2컨테이너 모두 확인 |
| 다섯 역할 | 각 mini→M3 교체 뒤 전체 readiness/progress gate 통과 |
| 양 서버 이미지 | 실제 pull 성공, arm64/OCI revision/웹 키 일치 |
| migration0076 | 직접5432에서11워커 drain→exit0→복제본 복구; journal77 |
| 품질 카운터 | integer/NOTNULL/default0, 실행 당시38,593행 backfill mismatch0/invalid0 |
| 소개 검수 | not_before2100-01-01, lease없음 보존 |
| 공개 웹 | 양 인스턴스 health 정상, 홈200/새 runtime 참조/정적 자산17개200 |
| 관리자 | 정상 password/CSRF 로그인·크롤러 탭200·13개 수집기/주/예비/최근 실행 표시 |
| 공개 관리 경계 | `/admin/status`404 |

worker digest: `sha256:17b84adb6ce05522615cbe536cb2db080f85dbd7339c1a6462b425d98d42e932`.
web digest: `sha256:8a2bd456f6ff7b825fc0319a4795af08cf0d55219f9729071fd682040fd52132`.

첫 cb6b719 배포에서는 migration과 text2앱만 완료한 뒤 SQL gate 실패로 멈췄다.
혼합 릴리스의 별도 baseline을 저장하고, 새 target에서13앱을 모두 교체했다.
이미 검증한 migration을 재실행하거나11워커 drain을 반복하지 않았다.
source5의 provider·환경·명령·복제본·키·기능 플래그는 보존했다.
실제 증거는 저장소 밖0700 디렉터리/0600 파일로 보관한다:
`/Users/jr/.config/nomorevibe/releases/2026-10-14-progress-query-fix`의
verification.json, rollout-steps.json, migration.json, admin-http-proof.json,
public-http-proof.json/public-assets-proof.json과 target/main-ci/merge-proof다.
원래 baseline과 migration은2026-10-14-cb6b719 디렉터리에 별도로 보존한다.

## 집계 SQL 원인과 검증

evidenceProgress는 기존3초 statement_timeout에서 실패했다. 최초 운영 EXPLAIN은4,411.656ms였고
주소 정규화의 반복 계산, 긴 AI키별 반복 인덱스 조회, 대량 입력의 병렬 locale 정렬을 차례로 확인했다.
canonical URL fastpath는 원래 mode별 식을 fallback하며 실제DB의14,407개 변형에서 차이0이었다.
ai_public과 현재버전5필드의ai_current를 MATERIALIZED로 공유하고, 단일PK에 근거한 seen LEFTJOIN을
사용해 중복 계산·반복 조회를 줄였다. agent의 동일 UNION 입력을 MATERIALIZED로 옮기고
같은 GROUP BY/min을 적용해 병렬 sorted finalization을 제거했다.
수요 범위·NULL·버전·정책·집계·3초 제한은 유지했다.

동일 snapshot·파라미터의 운영 읽기 전용 비교는4,261.188→1,411.068ms, 세 집계 결과 전체 일치,
최종 EXPLAIN1,490.680ms였다. 80k 최장 유효 주소의 local custom1070.842→925.507ms,
generic1045.951→947.346ms도 동일 집계이며 해당 정렬 경로가 제거됐다.
80,000건은 로컬/CI 전용 가상 성능 데이터이고 운영에 삽입하지 않았다.

MATERIALIZED-only, canonical fastpath, AI currentjoin의 이전 CI38557315298/38558982971/38561746654는
80k 회귀만57014로 실패해 병합하지 않았다. 마지막 실패 진단은3286.562ms 중 agent2241ms/AI1035ms였고,
긴키의 locale 정렬이 남은 병목이었다. 최종 input materialization 이후 PR와 main CI의 동일 회귀가 모두 통과했다.
실패 진단은 전용 TEST_DATABASE_URL에서만12초 readonly EXPLAIN의 안전한 plan/settings를 출력하고
sanitized57014로 다시 실패한다. 테스트 외곽40초는 진단용이며 SQL3초/fixture80k 기준은 유지했다.

원래 최종 단위256파일2468, 관리자집중59, Next typegen·TypeScript·i18n·lint·build·bundle와
원래통합1546개가 실행돼 통과했다. 최종SQL변경의 집중15/15·두파일lint·TypeScript0,
CI환경 fullshard2의48파일446검사(66.12초), 최종 PR/main 전체 검사가 통과했다.
기존 통합todo1은 실행하지 않았다. vendor lint warning1은 기존 항목이다.
공개 번들은 home148.6/detail158.9/launch136.1KBbr로 기준선10% 이내였다.

원래 PR의 내부 deadline 취소 누락은 combinedsignal을 검사하는 최소 수정으로 해결했다.
요청 진입·취소 원인·빠른 반환·늦은 응답 뒤 쓰기 없음까지 RED→GREEN을 확인했다.
관리자 리뷰의 failed스캔 신호·오래된 예비 관측·독립 요청 오류 표시 회귀도 수정했다.
최종 native/static CLI 리뷰는 CLEAN/No findings/OK다. CLI가 실행하지 못한 Vitest는 통과로 합산하지 않았다.
직접 CLI8회는 모두 gpt-6.1-sol/xhigh이며 입력8,100,798(캐시7,424,128포함), 출력57,262토큰이다.
private review-usage.json이 실제 사용량 증거다. native사용량은 추정하지 않았다.
설치되지 않은 gstack 체크리스트를 실행했다고 기록하지 않는다.

## 남은 운영 관측

배포 완료와 처리 용량 목표 달성은 구별한다. source 성공/partial/due·최장 지연·304 비율·API quota,
신규 수집 지연·fresh 재수집→규칙 판정·24시간 안정성·외부 monitor 실제 수신·백업 복구는
[PENDING](../../PENDING.md)의 별도 항목이다. 유지 하한3,453source/h와 catch-up5,500source/h는 아직 달성으로 표시하지 않는다.
X 목적 승인·실제 청구액·상시 예산·프로젝트 연결 품질·공개 HOT는 별도 후속이다.

Cloudflare HTML tag purge는 기존 Keychain 토큰의 Authentication error로 실패했다.
공개 홈은 DYNAMIC/private no-store, 새 runtime 참조와17개 자산200을 확인했다.
기존 purge 인증 항목은 PENDING에 남겼으며 성공으로 기록하지 않는다.
처음 자산 HEAD 검사는 HTTP helper의 기본 요청 헤더에서403이었고, 명시한 release health agent와
동일 origin Referer로 정상 요청해 CSS HEAD/GET200과 전체17개 HEAD200을 확인했다. 운영 코드는 바꾸지 않았다.
