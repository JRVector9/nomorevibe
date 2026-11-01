# 2026-11-01 신뢰성 작업 재개와 실제 상태

사용자 목표는 웹·백엔드 자동 복구, Oracle의 수집부터 검토·승인·한국어 번역까지 감시·복구·관리자 알림, 모든 페이지 병목 및 논리·보안 문제 개선이다. 이 문서는 첫 수정 묶음과 관측 근거다. 전체 목표 완료 기록이 아니다.

기준 main은 `f70901181e89e95e4e4a9d916b27f8a6d22a6e32`다. 원래 작업 폴더의 오래된 브랜치와 수정 파일을 보존하고 별도 worktree에서 작업했다. 세 병렬 에이전트는 모두 `gpt-6.1-sol/xhigh`다. 스킬을 사용하지 않았으며 사용자 지시대로 로컬 테스트·lint·typecheck·컴파일·build는 실행하지 않았다. 작성한 회귀의 실제 결과는 필수 GitHub CI로 확인해야 한다.

## 운영에서 직접 확인한 것

시각은 UTC다. 원문은 저장소 밖 `~/.local/state/nomorevibe-reliability-20261101`의 0700 디렉터리·0600 파일에 보존한다.

- **13:41:05**: 정규 `release_runtime.collect_baseline`으로 등록된 18앱의 source·image·spec·실행체와 안정된 관측 창을 확인했다. 모두 `439dea9a573d0ecf1b0f2e8bf2bd1e2ac673a6e9`다. 오래된 문서의 `61dc57be`가 현재 운영이라는 해석은 틀리다. 서비스 건강은 모든 업무의 완료를 뜻하지 않는다.
- **13:39:44**: Oracle watchdog은 active/running, PID482574, `NRestarts=0`, `recover=true`였다. 감시 대상 19개 중 monitor-m3는 `pipeline_alarm`, 별도 공급자 실패는 `keyword-verify`다. 설치된 watchdog/gateway/notifier 세 소스는 현재 main과 hash가 다르다. 앱 배포만으로 Oracle 설치가 갱신되지는 않는다.
- **13:44:58**: 5분 처리량은 fetch194, AI1 124, publish97, evidence171, agent-evidence1, reason-translate10, product-translate21이다. AI2는 대기0이다. 검색 검증은 완료0·오류34·`upstream_stalled`다. 역할 다섯 개와 scheduler는 ready였다. 장부 요약은 `ok`, 미확인0·stuckDispatched0이었다.
- **13:50:59**: 최근 장부 5000행 안의 10분 표본에서 Supa 검색 검증72건·후보 소개20건이 `gateway_not_started`로 정산됐다. 검색 검증의 실제 `verified_at`은 최근5분0건, 마지막11:01:01이었다. 잡의 `last_success_at` 전진을 모델 결과 저장으로 혼동하지 않는다.
- **13:59경**: GPU3090의 실제 Tailscale 상태에서 Supa `100.78.219.124`는 `Online=false`, `LastSeen=2026-10-31T04:22:37.1Z`였다. Supa SSH도 timeout이었다. 의도적 중지인지 사용자에게 확인을 요청했다. 다른 모델로 바꾸거나 공유 모델을 강제 재시작하지 않았다.
- 기존 release439dea9a 관측 프로세스 PID3713538은 사라졌고 새 배포/관측 프로세스도 없었다. 첫 5분 관측은12:55:25 실패, summary는 `stopped=true, completed=false`다. 실제 원인은 `reviewer=owner_mismatch,progress=alarm` 관문 timeout이다. 새13:44 역할 ready를 당시 실패의 소급 통과로 쓰지 않는다. 기존 관측을 재실행하지 않았다.
- **13:53:21**: 익명 홈페이지 MISS 다음 복구 쿠키 요청은 HIT였다. 복구 쿠키와 origin no-store만으로 이미 저장된 edge 객체를 피한다고 주장할 수 없다. 기존 purge 자격으로 cache rules 읽기는403이다. **13:56:39** 새 `__nmv_recover` query key 요청은 MISS, 같은 key 재요청은 HIT였다. 자동 복구 GET의 별도 query key 방식에 대한 현재 edge 근거다. 실제 오류 주입·복구 성공은 아직 확인하지 않았다.

## 수정 묶음과 리뷰

| 묶음 | 구체적인 결함과 수정 | 소스 검토 / 남은 검증 |
| --- | --- | --- |
| 웹 | 제한된 화면 GET 복구, 관리자 오류 경계, 목록 보조 집계 실패 분리, 예외 응답 no-store, 관리자 필터 own-key 검사 | 48개 page 진입점·78개 route 목록 전수 소스 검토. 실제 브라우저·CDN·로그인·페이지별 지연 실측은 남음 |
| 파이프라인 | 미확인 비점유 정책과 관측 일치, 만료 예약의 마지막 일감 숨김 해소, 발행 보류의 lease/DR fence, 실제 현재 consumer에만 quota backoff 인정 | root와 다른 에이전트의 독립 소스 검토. 회귀 코드 작성만 완료, 실행하지 않음 |
| Oracle | unhealthy monitor 알림 누락, 부분 replica 읽기의 잘못된 경보 해제, 손상된 음수 복구 이력, aggregate DOWN 중 새 단계별 장애 알림 | root와 다른 에이전트의 독립 소스 검토. 복구 권한·상한·버전 CAS·임대 정책은 유지. 설치와 실제 수신 확인은 남음 |

각 세부 근거와 적용 순서는 같은 날짜의 `web-route-audit`, `pipeline-logic-audit`, `oracle-backend-audit` 문서를 따른다. 소스 리뷰에서 차단 사항을 찾지 못했다는 결과는 실행 검증 통과가 아니다.

## 전체 목표의 미완료 범위

1. 수정 묶음의 필수 CI·정규 병합·앱 배포 및 Oracle→host gateway→monitor 순서의 별도 설치가 필요하다. 원 state/config/key/알림 ACK/복구 예산·실패 영수증은 보존한다.
2. discovery 검색/cursor 정체는 아직 `readMonitorStatus`의 입력이 아니다. 프로세스가 정상인데 신규 검색이 멈추는 경우를 관측·알림·안전한 로컬 복구에 연결해야 한다.
3. Supa 장애 시 대체 모델·복귀는 현재 명시된 모델 선택, 물리 한도, 검수 독립성 및 의도적 중지 여부를 보존하는 설계·운영 확인이 필요하다.
4. 실제 웹 오류·DB 일시 불통·active standby·consumer·전체 host 장애에서 복구와 관리자 수신을 입증해야 한다. 호스트/DB 재해 복구와 백업 복원도 소스 존재만으로 완료가 아니다.
5. 모든 페이지의 실제 지연/쿼리 계획과 큰 관리자 OFFSET, 인증 상태·locale·모바일의 동작을 확인해야 한다. 정적 경로 목록만으로 전 페이지 병목 개선 완료를 선언하지 않는다.
6. 지속6시간·24시간 관측은 미완료다. 이전 실패 표본과 미래 예약을 보존하고, 실제 경과 표본만 완료로 센다.

목표는 계속 active다. 현재 남은 특정 자격 하나를 전체 작업의 blocker로 확대하지 않으며, 수행 가능한 소스 수정과 운영 관측을 계속한다.
