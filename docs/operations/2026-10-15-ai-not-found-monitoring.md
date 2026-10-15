# AI 제작 근거의 정상 재확인 대기와 장애 집계

## 문제와 실제 원인

자동 내림 릴리스의 reviewer 두 앱은 healthy였지만 전역 진행 게이트가 시간 초과됐다.
2026-10-15 10:40 KST 실제 진단에서 모든 역할·scheduler readiness가 ready였고,
모든 lane/liveness/scheduler는 정상이었다. 유일한 경보는 AI 제작 근거 단계의
`waiting=0/deferred=90/providerErrors=90/reason=upstream_stalled`였다.

10:43:01 KST의 canonical READ ONLY 조회는 이 90개가 모두 `not_found`이며,
재확인 시각이 미래임을 확인했다. 첫 재확인은 UTC 2026-10-15 23:18:22.104였다.
해당 job의 last_error는 NULL이고 마지막 성공은 UTC 01:42:04.156, runs는 7,499였다.
오래된 저장소 없음 응답도 공급자 오류 수와 나이에 포함했고,
분류기가 오래된 오류를 정상 backoff보다 먼저 평가하면서 전역 경보가 됐다.

## 변경

[PR423](https://github.com/JRVector9/nomorevibe/pull/423)은 AI 집계의 공급자 오류 수·나이에서
정확한 `not_found`만 제외한다. 정상 72시간 재확인 대기 수, 실행 대상과 재확인 일정은 유지한다.
재확인 시각이 지난 미처리 대상은 기존 지연 경보를 내고,
실제 `unknown`·인증·제한 오류, 역할·lane·스케줄러 장애는 기존 경보를 유지한다.
다른 근거 단계와 DB 기록·모델·작업 처리 용량은 변경하지 않았다.

실제 DB 회귀 2개 RED 후 관련 통합 27개, 단위 31개, ESLint·diff 검사가 통과했다.
처음 타입 검사는 PageProps 미생성으로 실패했고, 저장소의 Next 문서를 확인해 typegen 후 통과했다.
독립 리뷰에서 추가 P0/P1/P2는 없었으며, 리뷰 담당자가 단위 11개와 diff 검사도 직접 통과했다.
PR CI38667723469 전체 quality·통합3개·필수 check 성공 후 정상 squash 병합했다.
main은 `347d647cc21a272e3e5b6acc1a0fd41f2190f173`이며,
[main CI38668156608](https://github.com/JRVector9/nomorevibe/actions/runs/38668156608)의
전체 검증과 웹·워커 이미지 생성이 실제 성공했다.
운영 적용 완료 여부는 아래 후속 실제 결과와 handoff를 따른다.

## 배포 게이트와 실패한 접근

첫 자동 내림 배포는 원본 게이트 실패 시 뒤 배포를 멈췄다.
읽기 전용 증거로 알려진 항목만 구별하려던 private 예외 prototype은
17개 로컬 테스트를 통과했지만, 독립 리뷰가 전체 계약 누락·내부 시각 노후화를 허용하는 P1을 발견했다.
이 예외로 배포한 적은 없으며 원본 helper에 설치하지 않고 REJECTED로 격리했다.
prototype의 유일한 실제 읽기는 전체 진행 정상 분기로 통과했다.
새 정상 처리 기록 뒤 원본 게이트가 다시 정상일 때 원본 그대로 재개해
자동 내림 릴리스 13앱을 UTC 01:51:28.225에 모두 검증했다.
후속 모니터 수정 릴리스도 원본 게이트를 사용한다.

새 릴리스 전용 baseline은 기존 94b025ef의 13앱·18컨테이너를 실제 읽어 별도로 저장했다.
private helper는 releases/2026-10-15-ai-not-found-monitoring이며 환경·모델·복제본을 보존한다.
이번 수정도 DDL이 없고 기존 schema journal77을 읽기 전용으로 확인한다.


## 실제 운영 적용 — 2026-10-15 11:10–11:11 KST

양 서버 이미지 다운로드·사전 검사와 schema journal77을 실제 확인한 후,
UTC 02:05:46.439에 원본 게이트를 사용하는 마지막 순차 배포를 시작했다.
02:10:57.671에 전체 19단계가 exit0으로 끝났으며, 13앱·18컨테이너가 모두 새 code SHA와 일치했다.
다섯 역할은 모두 정상 primary/standby readiness와 전체 진행 게이트를 통과했다.
Source 배포 5앱의 각 537개 tracked runtime 파일 해시가 로컬 code SHA와 일치했다.
M3·mini 양 웹 공개 health는 ok였다. HTML purge도 별도 호출에서 ok/errors0을 확인했다.
모델·복제본·수집 중단 설정은 유지했다. DDL은 없었으며 소개 검수 중단 해제도 보존했다.

배포 이미지 digest:

- worker: `sha256:0f19016253c951069551f8c4cc8cb03ceb6c0e84fb2f90b679f0568c6b61ce1f`
- web: `sha256:16008a0db09f90351579d4d32d7631e239ea5d5af4df9da5f34930ff18ffe5de`

UTC 02:10:47.976의 실제 후속 조회에서 AI 제작 근거 단계는
`waiting=0/deferred=88/providerErrors=0/providerErrorMinutes=NULL/reason=backoff/alarm=false`였다.
전체 진행도 ok였고 별도 최종 monitor도 5역할 ready/readiness ok/progress ok를 확인했다.
관측 사이 정상 작업으로 대상 수가 달라지므로 처음 진단한 90개와 현재 88개를 같은 고정 집합으로 계산하지 않는다.
근거 출처와 제작 근거 스캔은 각각 waiting48,300/14,385이며 정상 progressing이었다.
다른 단계의 실제 공급자 오류·부분 실패는 지우거나 성공 처리로 바꾸지 않았다.

비공개 배포 증거는 `releases/2026-10-15-ai-not-found-monitoring`의
`rollout-progress.json`/`verification.json` 및 역할별 gate 기록이다.
전체 배포 과정 session89922 exit0을 직접 확인했다.
현재 운영 code SHA와 이후 문서 전용 후속 PR의 main SHA를 구별하며, 문서 변경 때문에 13앱을 다시 배포하지 않는다.
