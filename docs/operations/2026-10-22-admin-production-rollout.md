# 2026-10-22 관리자·보안 릴리스 배포

운영 코드 릴리스는 `5ba60a1aef1878add561152ef8273b2df87e03d4`다.
2026-10-22 20:27 UTC(10-23 05:27 KST)에 M3·mini의 **15개 앱, 20개 컨테이너**를 확인했다.
공개 서비스는 [nomorevibe.com](https://nomorevibe.com)이다. 이 배포 기록 이후의 문서 전용 main 변경은 운영 코드 SHA와 구분한다.

같은 날 22:55 UTC에 읽기 전용 monitor 1개와 Oracle의 별도 Kuma 수신기를 추가했다.
현재 16 Dokploy 앱/21컨테이너의 구성과 감시 드릴 결과는 [후속 감시 연결 기록](2026-10-22-worker-monitor-rollout.md)을 따른다.
아래의 15앱/20컨테이너와 알림 미연결 설명은 20:27 UTC 배포 당시의 이력이다.

## 병합과 이미지

- [#620](https://github.com/JRVector9/nomorevibe/pull/620): Vite 8.3.3 보안 패치.
- [#621](https://github.com/JRVector9/nomorevibe/pull/621): 관리자 개별 잡 중지·재개, 선택적 외부 monitor Push 수신기 지원.
- [#622](https://github.com/JRVector9/nomorevibe/pull/622): 문의 수동 접수·처리, 메이커 답장 검수, migration `0117_admin_requests`.
- [#624](https://github.com/JRVector9/nomorevibe/pull/624): Next·ESLint 16.4.1. 배포 준비 중 새로 등록된 Next critical 2건·high 1건을 함께 해결했다.

모두 최신 base의 필수 `check` 성공 후 정확한 head로 squash 병합했다. #624의 최초 CI에서는
워커 시작 검사 1건이 하네스의 4초 제한에 걸렸다. 해당 파일 로컬 30/30 확인과 동일 head의 실패 작업 재실행 후
[PR CI](https://github.com/JRVector9/nomorevibe/actions/runs/39845450608)가 성공했다.
[최종 main CI](https://github.com/JRVector9/nomorevibe/actions/runs/39846813552)의 check·이미지 발행도 모두 성공했다.
중복 Dependabot PR #623은 닫았다.

| 이미지 | 실제 배포 digest |
| --- | --- |
| worker | `sha256:425e6ff174aeaf2fc19c322f516ea5fb2c7748509a7a5f40464fe6b4eb78b108` |
| web | `sha256:a6e7c18f7d48b04fc85697d03e19c49c7924d5a409ac49d7571a1f8c2d671ba4` |

두 서버에서 실제 pull·arm64·OCI revision·웹 빌드 키 일치를 확인했다. 웹 6개 컨테이너에서
Next **16.4.1**, Next가 읽는 sharp 패키지·native **0.35.5**, release·deployment ID 일치를 직접 확인했다.
Git 빌드 6개 앱의 모든 컨테이너는 런타임 파일 **921개**의 해시가 목표 checkout과 같았다.

## DB와 실제 배포

15개 앱의 원본 설정·이미지·복제본을 Git 밖의 0700 디렉터리/0600 snapshot에 보존했다.
새 catalog 잡이 없어 scheduler 선행 교체는 필요하지 않았다. scheduler → mini 예비 → M3 역할·소비자 → 웹 순으로 중지했다.
실행 컨테이너와 DB의 jobs·role leases·item leases·model calls가 모두 0인 것을 확인한 뒤 직접 5432로 migration을 실행했다.

20:15 UTC에 migration exit 0, journal **118개**, latest `1794086400029`, SQL hash 일치를 확인했다.
`admin_contact_requests`, 두 queue index, maker reply의 두 NOT NULL/default 컬럼과 rejected backfill을 확인했다.
invalid review version·재검수 표시가 빠진 rejected reply는 모두 0건이었다. 원래 이미지와 복제본으로 복원한 뒤 새 코드를 배포했다.

공통 8앱은 publisher → reviewer → crawler, 역할마다 mini → M3, 마지막 mini → M3 웹 순서였다.
각 역할의 readiness/progress와 실제 digest·release·컨테이너 수를 확인했다. 공통 배포는 사전 검사 12.6초와 실행 102초였다.
agent-scan 소비자는 기존 릴리스가 공통 8앱과 달라 별도 snapshot과 같은 배포 함수로 교체·검증했다.
Git 빌드 앱은 mini text·maintenance 2개를 먼저 함께 올리고, 모두 검증한 뒤 M3의 text·maintenance·scheduler·connect 4개를 함께 올렸다.

| 앱 | applicationId | 실행 복제본 |
| --- | --- | ---: |
| publisher-mini | `DWncl_MAWSx83j-qfNSyW` | 1 |
| publisher-m3 | `AeTaWnZbZKzzv94h7c8Vw` | 1 |
| reviewer-mini | `Len0UIDDJlawK2jvnnPjl` | 1 |
| reviewer-m3 | `4RlA9EeKvtKGdR6c6AV4j` | 1 |
| crawler-mini | `GfIKV_iTLs3uifo-A3ate` | 1 |
| crawler-m3 | `AFHDBGCCY4zT9XkkcnzGd` | 1 |
| web-mini | `llv4rlABSJOcFauSxaHdx` | 2 |
| web-m3 | `oipo2OAnIrtcnILBCRoG2` | 4 |
| text-mini | `YwCZROZf_V0qgI1coMugP` | 1 |
| text-m3 | `Pi0loosJrKsse_UQ0mln9` | 1 |
| maintenance-mini | `T6ATm-paaE03hfSsQX8-S` | 1 |
| maintenance-m3 | `7OlFqQdacbyQseQM72E7b` | 1 |
| scheduler-m3 | `uAjLU7MslLIGpORD9h6LQ` | 2 |
| connect-agent-m3 | `xJK6CoRUOs_bpVVNmJDBF` | 1 |
| agent-scan-consumer-m3 | `LIRNQFq9mWGBOWRshJ-19` | 1 |

최종 inventory는 **complete=true, pending=[]**이고 모든 앱의 설정·최신 배포 상태는 done이었다.
다섯 역할 모두 M3 주가 쥔 ready, worker progress ok, scheduler 2복제본 ready를 확인했다. Oracle은 이 Dokploy 배포 범위 밖이다.

## 검증과 유지 설정

- 공개 health에서 M3·mini 모두 목표 SHA/DB ok. curl로 홈·한국어/영어 login 200, `/ko/login` → `/login` 308을 확인했다.
- 실제 웹 6개 컨테이너에서 메모리 안의 5분 임시 세션으로 문의·답장 검수·inbox·운영센터 **24회 GET**: 모두 200·제목 일치·렌더링 오류 없음.
  공개 관리자 경로 **5개 GET은 모두 404**였다. 쿠키·HTML·비밀값은 저장하지 않았다. 이 검사는 실제 Tailscale 프록시 로그인 흐름의 재검증과 구분한다.
- 문의·답장·잡 상태를 바꾸는 운영 시험이나 이메일/Telegram 전송은 하지 않았다. 문의함은 수동 접수이며 메일함 연동이 아니다.
- 20:27:29 UTC DB 재확인: 화면 검수 enabled/autoClose true·**perTick 1**, auditHold **minConfidence 0.95**. 918건 파일을 실제 일괄 적용하지 않았다.
- agent-scan·connect 앱의 autoDeploy만 migration 중 잠시 껐다가 **원래 true로 복원**했다. 그 밖의 설정은 보존했다.
- 이 배포 시각에는 외부 monitor Push URL이 미설정이었다. mini의 기존 Uptime Kuma/Telegram 채널을 발견했고,
  worker Push·M3/mini 밖 deadman 연결은 [후속 감시 연결 기록](2026-10-22-worker-monitor-rollout.md)에서 이어 진행했다.
- 자동 HTML purge는 토큰이 없어 skipped였다. 관리자 페이지는 공개 CDN 캐시 대상이 아니며 공개 페이지의 기존 TTL은 유지했다.

## 실행 중 확인한 주의

Dokploy stop은 Swarm 종료를 기다린다. 앱의 stop grace가 60초인데 처음 30초 API 제한으로 scheduler 중지 응답이 시간 초과됐다.
scheduler는 기존 2복제본으로 자동 복원됐으며 그 시도에서는 migration·웹 중지가 없었다. 다음 실행은 lifecycle 응답 제한을 180초로 두고,
각 중지 묶음의 요청을 모두 기다린 뒤 진행했다. 모호한 쓰기는 자동 재시도하지 않았다.
Dokploy start는 1복제본으로 고정하므로 다중 복제본은 원본 설정·이미지를 확인한 reload로 복원하고 실제 개수를 대조했다.

Next 로컬 standalone을 `HOSTNAME=127.0.0.1`에 바인딩하면 localhost 정규화로 `/login` 자기 redirect가 생겼다.
기존 16.3.8에서도 재현됐고 운영과 같은 `HOSTNAME=0.0.0.0`에서는 두 버전 모두 정상이다. 앱 코드·Next flag를 바꾸지 않았다.
패키지 검증에서 sharp는 `package.json` export를 막으므로 resolve한 entry 옆의 metadata와 실제 native 버전을 함께 읽었다.
