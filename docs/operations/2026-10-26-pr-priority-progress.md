# 운영 수정 및 상세페이지 PR 진행

**기준: 2026-10-27, PR686 배포 전.** PR668–679·681–686은 병합했다. PR685 main `20493cfdf43b98bcb239bc8d097a705707da23d9`의 필수 CI와 웹·워커 이미지가 준비됐고, DB journal138·정확한 요청 회수·Connect 수정 배포·공식 OPEN20475를 실제 완료했다. 나머지17앱은 기존50f이며, 최신 전체18앱 최종 인증과 새 observer 결과는 아직 없다.

검색 프로필에서 이미 예약된 제품이 최신12개 선택 범위 밖으로 밀려 호출 없이 만료되는 원인을 추가 확인했다. 이를 고친 [PR686](https://github.com/JRVector9/nomorevibe/pull/686)은 head `4fd6981b61cd447fd237dfc274a1fb561a3cf6b4`, 독립 소스 검토와 필수 자동 CI40382748901 전체 성공 후 **2026-10-26 19:07:47 UTC** 병합했다. 최신 main은 `34cc2045cbb7105313861792adb37c035b64e70c`이며 새 main CI40383949515의 필수 check·웹/워커 이미지 발행도19:08 UTC대에 모두 성공했다. 검증한 PR tree·이미지를 재사용했고 refresh-caches는 관문이 아니다. 운영 배포는 아직 미완료다.

첫 자동 CI40381826340의 ledger8건은 role lease의 추가 owner 필드를 strict Zod 입력으로 넘겨 실패했다. SQL 오류가 아니며 `instanceId`·`bootId`만 투영하는2줄 수정 후 새4fd6981b를 push했다. 엄격한 schema·dispatch·테스트는 유지했고 root·독립 소스 검토를 마쳤다. 이전 CI의 integration1·5는 당시 실행 중이어서 전체 통과로 세지 않는다. 원 로그는 비공개 `STATE/ci686-ledger-job.private.log`에 보존한다. 후속 CI40382748901은 전체 성공했다. 실패한 첫 CI 이력은 그대로 보존한다.

| 묶음 | PR | 해결한 문제 | 실제 확인 범위 |
|---|---|---|---|
| 의도한 중단과 장애 구분 | [668](https://github.com/JRVector9/nomorevibe/pull/668)·[674](https://github.com/JRVector9/nomorevibe/pull/674)·[678](https://github.com/JRVector9/nomorevibe/pull/678) | DRAIN 중 과거 오류·정상 대기를 현재 장애로 오인 |50f 운영 반영·DRAIN/OPEN 확인. 생존·실제 오류 경보 유지 |
| 대기 배치 이어받기 | [671](https://github.com/JRVector9/nomorevibe/pull/671)·[677](https://github.com/JRVector9/nomorevibe/pull/677)·[679](https://github.com/JRVector9/nomorevibe/pull/679) | 자기 배치를 놓치거나 SQL OR 범위가 넓어 같은 요청 반복 취소 | text 주·예비50f 반영, 실제 제품 번역·한국어 문구 저장 확인 |
| 번역 요청문 정합성 | [676](https://github.com/JRVector9/nomorevibe/pull/676) | 보존 토큰·자연스러운 영어 문장 조건 누락 | 운영 반영. 품질 기준·모델·재시도 정책 유지 |
| 배포 읽기 검증 | [669](https://github.com/JRVector9/nomorevibe/pull/669)·[675](https://github.com/JRVector9/nomorevibe/pull/675) | 출처·시각 정밀도·일시 JSON 읽기 오류로 완료 확인 중단 | 공식 도구 반영. 읽기 실패에 배포 재요청하지 않음 |
| 상세 정보 압축 | [672](https://github.com/JRVector9/nomorevibe/pull/672) | 같은 정보가 과도한 높이를 차지 | 정보·보조 설명 유지, 로컬 컴포넌트201→173.5px(약13.7%), 모바일2열·라이선스 줄바꿈·운영 익명 화면 확인 |
| GitHub 소유권 확인 | [673](https://github.com/JRVector9/nomorevibe/pull/673) | 준비 중 안내·관리자 요청으로 끝나던 흐름 | 개인 숫자ID·조직 증명 파일 구현, 운영 로그인 진입 확인. 실제 OAuth·등록은 미실행 |
| 최신 업데이트3개 | [670](https://github.com/JRVector9/nomorevibe/pull/670) | 목록·필터·펼치기로 상세 화면 복잡 | 최신3개·전체 표시·날짜 내림차순, 운영 데스크톱·모바일 확인 |
| 종료 때 새 실행 차단 | [681](https://github.com/JRVector9/nomorevibe/pull/681) | 원격 CLI가 끝나기 전에 배포 종료되어 점유 잔류 | 새 실행 차단·최대180초 대기 구현. Connect healthy1·최신 소스·유예240초 실제 확인 |
| 정확한 한 요청 수동 복구 | [682](https://github.com/JRVector9/nomorevibe/pull/682)·[683](https://github.com/JRVector9/nomorevibe/pull/683) | 실행체 삭제·종료 코드 미확정으로 기존 계약 사용 불가 | journal136·첫 요청 회수 실제 완료. 알 수 없는 종료 코드는NULL, 비용·사용량 미확정 보존 |
| 네이티브 실행·미확정 회수 | [684](https://github.com/JRVector9/nomorevibe/pull/684)·[685](https://github.com/JRVector9/nomorevibe/pull/685) | npm 자식 실행기의 종료 미확정 및 실제 die 뒤 Swarm 작업 삭제 | 동일 바이너리 직접 exec, journal137/138 검증. 6c 요청 감사20474 withdrawn·C272000/사용량 미확정 보존. Connect20493 healthy·OPEN20475 완료 |
| 검색 프로필 예약 우선 처리 | [686](https://github.com/JRVector9/nomorevibe/pull/686) | 자기 예약 제품이 새 후보12개 밖으로 밀려 미사용 만료 |4파일 최소 수정·독립 소스 검토 완료. CI40382748901 전체 성공·main34cc 병합. 새 main 필수 CI·웹/워커 이미지 준비 완료. 공식 전체18 plan 진행 중, 운영 미반영 |
| 결과 문서 정리 | [680](https://github.com/JRVector9/nomorevibe/pull/680) | 진행 문단 누적으로 현재 상태 불명확 |50f 기반 draft. 현재 결과로 교체 중이며 최신 main 통합·병합은 root 담당 |

상세페이지3건은50f 운영 웹 두 곳에 반영됐다. **2026-10-26 13:19:31 UTC** 익명 GET/HEAD 검수에서 데스크톱1280·모바일375, 정보 누락·가로 넘침·브라우저 예외, 최신3개 표시, GitHub 로그인 진입을 확인했다. 실제 OAuth·claim·조직 증명 파일 등록 성공으로 세지 않는다.

**2026-10-26 18:54:22 UTC** stock monitor는 다섯 역할·scheduler·전체 progress=ok를 실제 통과했다. 영수증 `STATE/normal686-preflight-monitor-readback-20261027-a.private.json`의 SHA는 `8f2ce086fdf5ec5f73503fb8c655709180ed76a54aa946dd6b981c7e0ed8a09f`다. 이 표본은 현재 관문만 증명하며 PR686 배포나 이후 연속 정상·장기 관측을 증명하지 않는다. 과거12:57 인증과 뒤의 실패 구간도 별도로 유지한다.

**18:56:10 UTC** 실제 작업 읽기에서는 KO 오류가 남아 있고 나머지5작업은 오류 없음이었다. 영수증 `STATE/text-job-errors686-20261027-a.private.json`, SHA `ade300c0991de0c9f8e856e2aab072c6099616a4aa2be536fa0cbfa5f75f8a5c`. 오류 reset이나 새 DRAIN 변경은 하지 않았다. 앞선 관문 표본을 이후 오류 해소로 세지 않는다.

사용자 지시에 따라 **2026-10-26 14:37 UTC 이후 추가 수동 테스트·lint·tsc·컴파일을 실행하지 않았다.** PR686까지 필수 자동 CI 성공을 확인해 병합했다. 새 main 필수 CI·웹/워커 이미지도 성공했으며 공식 전체18 plan 진행과 실제 운영 배포를 구분한다. 이전 개발 단계의 실제 시험 결과는 당시 PR·인계 이력에 보존한다. 운영 읽기·DB 이전·정식 복구와 수동 회귀 테스트를 구분한다.

AI2는 GPU3090 Tailscale 직접 기본 `qwen3.8-flash-next`, abcLLM Supa Qwen3.8 대체, no-thinking·총32k/출력10k를 유지했다. 이번 작업으로 모델 선택·한도·번역 품질 기준을 바꾸지 않았다.

## 남은 확인

1. root가 새 main34cc·깨끗한 `/Users/jr/Desktop/projects/nomorevibe-release-686-20261027`에서 공식 전체18 plan 세션24626을19:09 UTC부터 실행 중이다. 경로는 `STATE/full18-release686-20261027-a`, `--migration-verified`. 아직 plan 파일·서비스 POST·실제 run은 없으며 계획 결과 검토 후 한 번만 실행한다. 소비한 stop·migration·canonical·finish·OPEN은 반복하지 않는다.
2. 실제 최종18앱 영수증과 배포 후 monitor UP·두 수신처·일반 관문 확인. **현재: 미완료.** root가 실제 SHA·경로·시각을 기록한다.
3. 최종 정상 확인 뒤 새5·10·15분/6시간 관측 시작과 실제 결과 수집, 별도24시간 관측. **현재: 새 observer 결과 없음.** 예약·일회 표본을 이후 통과로 세지 않는다.
4. 실제 사용자 OAuth·개인/조직 등록·멤버 관리·30일 재검증·증명 파일 삭제 회수.
5. 과거 보관본 복원/PITR·보존기간·볼륨/WAL 여유·실제 nonempty media_assets 복원. 이미 검증한9월29일 논리 dump·og_images 격리복원은 유지한다.

독립 사람 라벨5개·assist 자동 적용 꺼짐, 미복구 후보·보강 적체의 실제 품질, 전체 호스트 장애·저장 정체·반복 부팅/알림 드릴 등 기존 미완료는 [PENDING](../../PENDING.md)에 유지한다. 정확한 경로·다음 명령·소비한 once·원문 백업은 [인계](../CODEX_HANDOFF.md)를 따른다.
