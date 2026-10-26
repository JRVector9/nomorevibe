# 운영 수정 및 상세페이지 PR 진행

2026-10-26 22:27 KST 기준. 스킬 없이 저장소와 실제 운영 결과를 검토했다. 수정은 PR 단위로 분리해 모두 병합했다. 최신 main은 `50f9239c1b33b853513a632ca197be45ab26398a`이며 필수 CI와 이미지 발행이 성공했다.

| 우선순위 | PR | 해결하는 문제 | 확인한 범위 |
|---|---|---|---|
| 운영 1 | [#668](https://github.com/JRVector9/nomorevibe/pull/668), [#674](https://github.com/JRVector9/nomorevibe/pull/674), [#678](https://github.com/JRVector9/nomorevibe/pull/678) | 의도한 모델 작업 중단을 정체로 오인해 워커를 재시작하거나 과거 실패를 현재 장애로 표시 | 운영 반영, 실제 DRAIN/OPEN 확인. 발행 감시도 적용, 최종 정상 판정 대기 |
| 운영 2 | [#671](https://github.com/JRVector9/nomorevibe/pull/671), [#677](https://github.com/JRVector9/nomorevibe/pull/677), [#679](https://github.com/JRVector9/nomorevibe/pull/679) | 대기 배치를 이어받지 못하거나 SQL OR 조건이 다른 행까지 읽어 예약을 매번 취소 | text 주·예비 적용 완료. 실제 PostgreSQL 회귀, 새 주 서버의 모델 완료와 결과 저장 확인 |
| 운영 2 후속 | [#676](https://github.com/JRVector9/nomorevibe/pull/676) | 번역 요청이 보존 토큰과 자연스러운 영어 문장 조건을 충분히 전달하지 않음 | 동일 품질검사를 유지한 요청문 보완, 단위64개·DB8개, text 적용 |
| 운영 3 | [#669](https://github.com/JRVector9/nomorevibe/pull/669), [#675](https://github.com/JRVector9/nomorevibe/pull/675) | 나노초 시각·Healthcheck 상속·일시 JSON 오류 때문에 완료된 배포 확인이 중단 | 실제 runtime/source 검증과 회귀 통과. 읽기 오류에 앱 배포를 다시 요청하지 않음 |
| 상세 정보 | [#672](https://github.com/JRVector9/nomorevibe/pull/672) | 같은 정보가 화면 공간을 많이 차지 | 여섯 항목·보조 설명 유지. 로컬 실제 컴포넌트 높이201→173.5px, 모바일 두 열·줄바꿈 검증. 운영 웹 두 곳 반영·데스크톱/모바일 확인 완료 |
| 소유권 | [#673](https://github.com/JRVector9/nomorevibe/pull/673) | GitHub 확인이 준비 중이라 관리자 요청으로 끝남 | 개인 저장소 숫자 GitHub ID 확인, 조직 저장소 기본 브랜치 증명 파일 구현. 보안·DB·화면 검증 통과. 운영 웹 두 곳 반영·데스크톱/모바일 확인 완료 |
| 업데이트 | [#670](https://github.com/JRVector9/nomorevibe/pull/670) | 메이커·자동 감지 구분이 혼란스럽고 목록이 김 | 전체 표시와 최신3개만 유지. 필터·펼치기 제거, 날짜 내림차순 검증. 운영 웹 두 곳 반영·데스크톱/모바일 확인 완료 |

운영 text 두 앱을 먼저 `50f9239c`로 교체한 뒤, 공식 도구로 나머지16앱을 한 번씩 갱신했다.15개 앱은 실제 배포 영수증 검증을 마쳤다. 마지막 monitor도 새 버전·원 설정·source·healthy runtime·두 수신처의 실제 응답을 확인했으나, 업무 진행 경보 때문에 UP 상태가 되지 않아 최종 검증480초 제한에 걸렸다. 공식 실행은13:17:11 UTC에 중단됐고 전체18앱 정상 완료 영수증은 아직 없다. 완료된 앱을 다시 배포하지 않고 같은 요청의 실제 현재 상태만 대조한다.

12:57:43 UTC의 새 읽기 전용 관측에서는 제품 번역·한국어 문구의 실제 저장 결과, schema/hash/품질검사, 일반 운영 관문과 당시 전체18앱 상태를 모두 통과했다. 이후 최종 배포 검증 중 한국어 문구의 최근5분 성공0건 경보가 발생했다. 추가 실측에서 최근 서로 다른4개 제품의 모델 요청은 정상 종료했으며,52102는13:17:42에 실제 저장됐다.52103·52109는 `rejected:too_long`,52119는 `rejected:empty` 품질검사로 거절돼 정해진 재시도를 기다린다. Native 종료를 번역 저장으로 세지 않았고 품질·모델·토큰·capacity 정책·일반 관문은 바꾸지 않았다. 13:24:57 UTC 실측에서 capacity OPEN epoch1/revision3·결과 불명0을 확인했다.

운영 화면은13:19:31 UTC 새 GET/HEAD 검수에서 데스크톱1280·모바일375 모두 통과했다. 실제 채워진 정보7개가 잘리지 않고, 업데이트는 최신3개·전체 표시만 보이며, GitHub 버튼은 `/login?connectGithub=1&returnTo=/p/thinkrail#owner-claim`로 이동했다. 가로 넘침·브라우저 예외0, 스크린샷11개다. 초기 검수 스크립트의 기본 한국어 경로와 응답 수집 오류는 실제 routing 규칙에 맞춘 새 별도 스크립트로 수정했고 실패 기록도 보존했다. 실제 OAuth/소유권 claim은 실행하지 않았다.

AI2는 GPU3090 Tailscale 직접 기본 모델 `qwen3.8-flash-next`, abcLLM의 Supa Qwen3.8 대체 모델, no-thinking, 총32k/출력10k 설정을 유지한다. 이번 text 교체로 AI2 설정을 바꾸지 않았다.

남은 순서: 새 서비스 변경 없이 monitor UP·기존 일반 관문·전체18앱의 실제 상태 재검증 → 정상 완료 영수증 → 단일5·10·15분/6시간 관측 시작과 실제 결과 확인. 별도24시간 관측도 남아 있다. 실제 사용자 소유권 등록과 장기 백업 복구 검증은 수행하지 않았으며 별도 남은 항목으로 유지한다.
