# 운영 수정 및 상세페이지 PR 결과

**완료: 전체18앱 source/runtime34cc 확인·text6잡 재개. 미해결: 업무 진행 경보와 monitor UP.** PR668–679·681–686은 병합했고 최신 main은 `34cc2045cbb7105313861792adb37c035b64e70c`다. PR686 필수 CI40382748901과 main CI40383949515의 필수 check·웹/워커 이미지가 성공했다. 검증한 PR tree·이미지를 재사용했으며 refresh-caches는 관문이 아니다.

DB0137/journal138, 정확한 미확정 요청 회수, Connect 종료 대기·네이티브 직접 실행, 검색 프로필 예약 이어받기를 운영 반영했다. **현재 text6잡은 두 번째 재개까지 완료·모두 paused=false**다. 계획된 유지보수 pause는 없다. 실제 전체18 source/runtime 읽기 증명도 완료했으나 업무·일반 관문·monitor UP 확인은 미해결이다. 전체 정상·최종 인증·새 관측 완료를 주장하지 않는다.

| 묶음 | PR | 해결한 문제 | 실제 전달·확인 범위 |
|---|---|---|---|
| 의도한 중단과 장애 구분 | [668](https://github.com/JRVector9/nomorevibe/pull/668)·[674](https://github.com/JRVector9/nomorevibe/pull/674)·[678](https://github.com/JRVector9/nomorevibe/pull/678) | DRAIN 중 과거 오류·정상 대기를 현재 장애로 오인 | 운영 코드 반영. 실제 DRAIN/OPEN 확인, 생존·실제 오류 경보 유지 |
| 대기 배치 이어받기 | [671](https://github.com/JRVector9/nomorevibe/pull/671)·[677](https://github.com/JRVector9/nomorevibe/pull/677)·[679](https://github.com/JRVector9/nomorevibe/pull/679) | 자기 배치를 놓치거나 넓은 SQL OR로 같은 요청 반복 취소 | 운영 반영, 실제 제품 번역·한국어 문구 저장 확인. 모든 품질·장기 정상은 별도 |
| 번역 요청문 정합성 | [676](https://github.com/JRVector9/nomorevibe/pull/676) | 보존 토큰·자연스러운 영어 문장 조건 부족 | 운영 반영. 품질 기준·모델·재시도 정책 유지 |
| 배포 읽기 검증 | [669](https://github.com/JRVector9/nomorevibe/pull/669)·[675](https://github.com/JRVector9/nomorevibe/pull/675) | 출처·시각 정밀도·일시 JSON 읽기 오류로 완료 확인 중단 | 공식 도구 반영. 읽기 오류에 배포 재요청하지 않음 |
| 상세 정보 압축 | [672](https://github.com/JRVector9/nomorevibe/pull/672) | 같은 정보가 과도한 높이를 차지 | 정보·설명 유지, 로컬201→173.5px(약13.7%), 모바일2열·라이선스 줄바꿈·운영 익명 화면 확인 |
| GitHub 소유권 확인 | [673](https://github.com/JRVector9/nomorevibe/pull/673) | 준비 중 안내·관리자 요청으로 끝나던 흐름 | 개인 숫자ID·조직 증명 파일 구현, 운영 로그인 진입 확인. 실제 OAuth·등록은 미실행 |
| 최신 업데이트3개 | [670](https://github.com/JRVector9/nomorevibe/pull/670) | 목록·필터·펼치기로 상세 화면 복잡 | 최신3개·전체 표시·날짜 내림차순, 운영 데스크톱·모바일 확인 |
| 종료 때 새 실행 차단 | [681](https://github.com/JRVector9/nomorevibe/pull/681) | 원격 CLI보다 먼저 배포가 끝나 점유 잔류 | 새 실행 차단·최대180초 대기, Connect 실제 소스·healthy1·유예240초 확인 |
| 정확한 한 요청 수동 복구 | [682](https://github.com/JRVector9/nomorevibe/pull/682)·[683](https://github.com/JRVector9/nomorevibe/pull/683) | 실행체 삭제·종료 코드 미확정으로 기존 회수 계약 사용 불가 | journal136·첫 요청 회수 완료. 알 수 없는 종료 코드는NULL, 비용·사용량 미확정 보존 |
| 네이티브 실행·미확정 회수 | [684](https://github.com/JRVector9/nomorevibe/pull/684)·[685](https://github.com/JRVector9/nomorevibe/pull/685) | npm 자식 실행기 종료 미확정, 실제 die 뒤 Swarm 작업 삭제 | 동일 바이너리 직접 exec·journal137/138 검증. 6c 요청 감사20474 withdrawn·C272000/사용량 미확정 보존 |
| 검색 프로필 예약 우선 처리 | [686](https://github.com/JRVector9/nomorevibe/pull/686) | 자기 예약 제품이 새 후보12개 밖으로 밀려 미사용 만료 | 운영 반영. **19:29:48.471 UTC** 새1grant→1dispatch→1settled/generated 실제 확인, 새 profile 예약 만료 없음. 한 표본의 효과이며 전체 정상 증거는 아님 |
| 결과 문서 정리 | [680](https://github.com/JRVector9/nomorevibe/pull/680) | 진행 문단 누적으로 현재 상태 불명확 | 최신 main34cc 통합 후 실제 결과로 정리 중인 draft |

## 배포와 남은 최종 확인

첫 실행b는 Git7앱(text·maintenance·scheduler 주/예비와 Connect)을34cc로 배포·검증한 뒤 progress 관문에서 중단했다. 새 실행C는 그7앱을 유지하고 나머지11앱을 선택했다. C의10앱 verified와 monitor의 latest done·healthy1까지 실제 확인했다. 원 실행의 중단을 롤백·배포0으로 해석하지 않는다.

C의 마지막 실패는 **2026-10-26 19:47:10 UTC monitor source/health/push 확인 timeout**이다. 감시 역할에 `dr_writer_fence` SELECT 권한이 없어 실제 PG42501과 progress UNKNOWN이 발생했다. root가 활성 primary에서 **SELECT만 한 번 보완·감사20513 기록**했고 쓰기 불가·읽기 전용 설정은 유지했다. 앱 설정·모델 변경이나 재배포 없이 기존30초 읽기 재시도로 확인한다. grant·배포·회수 once를 반복하지 않는다.

읽기 전용 completion62719도 monitor UP timeout으로 EXIT1했고 원 실패는 보존했다.19:54:07 실제 읽기는 성공해 SELECT 오류는 해소됐지만 FIRST/SECOND 무진행으로 overall alarm이었다. 이후 별도 제한된 source/runtime 증명 **97182 EXIT0, 2026-10-26 19:56:03.736950 UTC**에서 변경 없는 stock verify_fleet로 selected11+retained7 전체18의34cc를 확인했다. snapshot `STATE/full18-release686-source-runtime-20261027/source-runtime.final.private.json`, SHA `1ce7da702b3b6a01423867ffddabf8c53977820fbd9499e95810363edb0de0da`. 결과는 **normalCompletionCertified:false**이며 정상 인증을 대신하지 않는다.

두 번째 resume30148은 감사20514–20519, **19:54:59.077–19:55:02.865 UTC**에 실제 완료했다.6잡 모두 paused=false이고 계획된 pause는 없다. 19:56 일반 관문은 **false: reviewer=owner_mismatch·progress=alarm**이었다. FIRST110/SECOND71 대기·5분 진행0, reason-translate9287 무진행, keywords14468/translate113147/KO542 upstream_stalled였다. monitor의 두 수신처 ACK·fresh는 true지만 **UP=false**다. 재개 직후 표본을 회복 완료로 세지 않는다. **최신80777 읽기(19:58:05.270076 UTC, `STATE/final-current686-readback-20261027-b.private.json`)에서는 reviewer 소유권이 자연 해소돼 모든5역할·scheduler가 ready이며 ONLY progress=alarm만 남았다.** FIRST/SECOND 무진행·text upstream_stalled가 남아 전체 정상은 여전히 미통과다.

stock observer는 실제 snapshot/hash에 결속해 **19:56:25.106637 UTC 한 번 시작**했다(PID51355,5·10·15분/6시간, productionMutations0·**futurePassed:false**). 시작은 시각별 관측 통과가 아니며 실패하면 driver가 중단한다. 중복 시작·재배포·소비한 once 재실행 없이 실제 결과와 미해결 진행 경보를 확인한다.

상세페이지3건은 **2026-10-26 13:19:31 UTC** 당시50f 운영 웹 두 곳에서 익명 GET/HEAD로 검수했다(데스크톱1280·모바일375, 정보·가로 넘침·브라우저 예외·최신3개·로그인 진입). 현재34cc에도 코드가 포함된다. 실제 OAuth·claim·조직 파일 등록 성공으로 세지 않으며 이후 새 로그인 검수도 하지 않았다.

사용자 지시에 따라 **2026-10-26 14:37 UTC 이후 추가 수동 테스트·lint·tsc·컴파일을 실행하지 않았다.** 필수 자동 CI는 유지했고 통과를 확인해 병합했다. PR686 첫 CI40381826340의 ledger8건은 role lease 추가 owner 필드를 strict Zod에 넘긴 실패였으며(SQL 원인 아님), `instanceId`·`bootId`만 투영하는2줄 수정 후 CI40382748901이 전체 성공했다. strict schema·dispatch·테스트는 유지했고 원 실패 로그는 비공개 `STATE/ci686-ledger-job.private.log`에 보존한다. 이전 개발 단계의 실제 시험은 당시 PR·인계 이력과 구분한다.

AI2는 GPU3090 Tailscale 직접 기본 `qwen3.8-flash-next`, abcLLM Supa Qwen3.8 대체, no-thinking·총32k/출력10k를 유지했다. 모델 선택·한도·번역 품질 기준을 바꾸지 않았다.

19:59:01.882659 UTC 실제 capacity 읽기에서 OPEN/epoch1/revision3은 그대로지만 **새 로컬 Deepseek 요청1건이 INDETERMINATE**로 남았다(`STATE/capacity-final686-readback-20261027-a.private.json`). active text 요청은 없다. 이 한 건이 진행 경보의 원인이라고 입증하지 않았으며, 과거6c와 구분해 실제 실행/모델 종료 증거와 정확한 현재 요청을 확인한 뒤 별도 복구를 검토한다. unknown 삭제·과거 once 재사용은 하지 않는다.

## 이후 남는 검증

- 실제 업무 진행 경보·monitor UP, 이미 시작한 observer의 실제5·10·15분/6시간과 별도24시간 결과. 예약이나 한 시점 정상은 후속 성공 증거가 아니다.
- 실제 사용자 OAuth·개인/조직 claim·멤버 관리·30일 재검증·증명 파일 삭제 회수.
- 과거 보관본 복원/PITR·보존기간·볼륨/WAL 여유·실제 nonempty media_assets 복원. 이미 검증한9월29일 논리 dump·og_images 격리복원은 유지한다.
- 독립 사람 라벨5개·assist 자동 적용 꺼짐, 미복구 후보·보강 적체의 품질, 전체 호스트 장애·저장 정체·반복 부팅/알림 드릴 등 [PENDING](../../PENDING.md)의 기존 항목.

정확한 영수증·현재 상태·완료한 재개 영수증·소비한 once·역사 백업은 [인계](../CODEX_HANDOFF.md)를 따른다. 관측 예약은 미래 성공을 뜻하지 않으며 미해결 항목은 실제 후속 결과로만 갱신한다.
