# PR03a fetch writer 실제 검증

2026-10-16 KST. 원래 PR03의 fetch 단위이며 AI1·공유 controller·legacy 외부 종료·item replay 인증까지 완료했다는 뜻은 아니다. 기본 legacy/epoch1/계약0과 새 consumer 비활성을 유지한다.

## 구현과 병렬 검토

gpt-6.1-sol/xhigh 담당3명을 source, 관리자 완료 helper, 독립 실제 DB 회귀로 나누고 파일·DB 소유권을 분리했다. source handback 뒤 root가 공통 guard read/stage 순서, collector 접점, 잠금 후 wallclock 검사를 통합하고 직접/교차 리뷰했다.

- fetch claim은 실제 frontier claim에 legacy job+stage epoch 또는 필수 item lease를 붙인다. source·실패·skip·quota 반환·복구가 같은 권한을 검사한다. 신규 item claim adapter는 production consumer에 연결하지 않았다.
- stage SHARE(fetch→ai1→ai2)→기존 domain→item→jobs/outbox. 현재 guard의 실제 tx/xid/stage와 실제 binding을 검증한다. HTTP 동안 transaction을 유지하지 않는다.
- source 저장·수락된 관리자 evidence 요청 소비·item release·필요한 judge 요청은 같은 transaction이다. 실제 document timestamp를 다시 읽으며 caller timestamp는 권한이 아니다. 사람 결정·공개 상태·judgedAt·이미 소비한 요청을 보호한다.
- 요청은 원본별 commit 안에서 증가한다. 원본3개 성공은 version3이며 중복 완료는0이다. 반납은 receipt별 짧은 transaction으로 각 frontier+release를 원자 처리한다. 뒤 항목 실패로 앞서 반납한 항목을 되돌리지 않는다.
- 기존 semantic assertJobLease는 유지한다. 새 assertJobLeaseAtWallTime은 먼저 job row를 잠그고 DB wallclock으로 token·expiry를 다시 검사한다. fetch와 관리자 완료 wrapper가 이를 재사용한다.

## 실제 RED와 수정

- 현재 runJob/handler가 items/draining에서 HTTP를 호출하고 healthy foreign item도 recovery한 실제3FAIL→GREEN. `/tmp/nomorevibe-pr03-independent-mode-red-20261015.log`.
- 후속 judge 요청을 trigger로 실패시키면 기존 source/frontier가 따로 commit돼 accepted evidence 요청이 미소비로 남았다. 실제1FAIL→같은 tx의 source/소비/release/request rollback 및 재시도 GREEN. `/tmp/nomorevibe-pr03-independent-atomic-red-20261015.log`.
- 첫 helper는 종료된 Drizzle tx 객체 identity만 검사해 autocommit 소비가 가능했다. 실제1FAIL 뒤 기존 opaque fetch guard의 full xid를 lock/apply에서 검증해 GREEN. `/tmp/nomorevibe-pr03-independent-ended-context-red-20261015.log`.
- 다른 stage의 authentic guard로 fetch legacy mode 검사를 우회한 실제1FAIL 뒤 stage discriminator 검사로 GREEN. `/tmp/nomorevibe-pr03-independent-stage-channel-red-20261015.log`.
- collector job row 잠금 대기에서 lease가 실제 wallclock으로 만료됐어도 기존 now()는 tx 시작 시각으로 소비를 승인했다. pg_blocking_pids·actual xact_start·DB healthy_at_start/expired_now를 확인한 RED1 뒤 wallclock 검사로 소비/요청 전체 rollback GREEN1. `/tmp/nomorevibe-pr03-admin-evidence-wallclock-{red,final-green}-20261015.log`.
- root 리뷰에서 새 frontier identity→candidate 순서가 기존 controller의 candidate→identity와 반대임을 발견해 불필요한 신규 advisory를 제거했다. 두 연결의 실제 candidate 대기·identity 획득 회귀 GREEN. 이 순서 문제를 별도의 실행한 RED로 과장하지 않는다.
- 기존 unit19의 무lease fixture 불일치, Next typegen 전 PageProps 누락, test readonly 타입 오류, 기존 묶음 요청 기대값1→실제3은 behavioral RED와 구분했다. business/소유권 assertion·timeout을 약화하지 않았다.

## 담당 실행 결과와 정리

- fetch unit4파일19PASS; 독립 실제 DB4파일71PASS(새25 포함, 7.96초); 기존 fixture4파일71PASS(6.66초); 별도 collector wallclock1PASS(1.09초).
- 독립 tsc·scoped lint, 마지막 fetch 담당 전체 tsc·관련 lint exit0.
- 자체55470/55471/55472의 fixture·item·연결 정리 및 legacy/계약0 확인 뒤 자체 컨테이너만 중지했다. 다른 작업자의 DB와 운영 DB에 접근하지 않았다.
- 두 담당의 최종 읽기 교차 리뷰와 root 직접 리뷰에서 마지막 소스 기준 미해결 P1/P2는 발견하지 않았다. 후속 PR03b 범위는 아래에 별도 남긴다.

## root 최종 통합 검증

- 실제 merged main8f2bdb3를 merge924dfa3으로 통합했다. 소스 충돌0. handoff stash의 문서 이력 충돌은 양쪽 이력을 보존해 해결했고 자체 stash만 제거했다.
- 최종 production source 고정 뒤 전체 unit277파일2,849PASS(7.15초), next typegen·tsc·전체 lint·i18n·Python23PASS. lint의 기존 vendor warning1. `/tmp/nomorevibe-pr03-root-{unit-final,typegen,tsc-final,lint-final,i18n-final,python-final}-20261016.log`.
- collector 접점의 기존 실제 DB39PASS(3.93초), budget unit5PASS. 해당 결과는 별도 실행이며 전체 suite 결과로 더하지 않는다.
- root 전체 integration164파일 **1,804PASS·기존TODO1**(349.72초), exit0. `/tmp/nomorevibe-pr03-root-db-final-20261016.log`. build와 bundle-size 모두 exit0. bundle 세 경로 모두 한도 이내다.
- root55473 최종 readback: 세 stage legacy/epoch1/계약0, item0, replay schema/role0, 자체 pr03 fixture/frontier/candidate/document/job/function/trigger0, 다른 연결0, DB PUBLIC CONNECT/TEMP 및 schema USAGE 복원 확인 뒤 자체 컨테이너만 중지했다.
- 최신base CI·원격 PR 납품은 아직 남아 있다.

## 남은 경계

실제 legacy 외부 호출 종료는 job90s·live item0·running0만으로 증명하지 않는다. runtime contract 변경 API가 없고 default contract0이므로 새 stage 전환/consumer는 비활성이다. generic fixture 상태 머신을 실제 legacy drain 인증으로 취급하지 않는다.

README/source·AI1 attempt/reuse·관리자/설정·발행 controller 및 B5 stage/item projection·journal·profile은 PR03b/04에 남는다. 현재 legacy replay 회귀를 전체 DB에서 유지하되 새 item 실행을 certified 처리량에 포함하지 않는다. 실제 provider baseline, 2배 성능·Oracle DR은 미판정이다. 운영 migration·수동 배포·provider inference·신규 발굴 재개는 수행하지 않았다.

## 향후 배포의 필수 순서

이 PR부터 기존 legacy handler도 stage/item 표를 읽는다. 운영 적용 시 PR02의 **0077 migration을 먼저 실행해 exit0를 확인한 뒤** 이 image를 시작해야 한다. 기존 runbook의 drain→migration→역할 image 교체 순서를 따른다. main image 생성은 운영 적용을 뜻하지 않으며 이번 PR 개발에서 운영 DDL·배포는 실행하지 않았다.
