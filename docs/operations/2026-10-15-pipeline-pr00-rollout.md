# PR00 운영 배포 기록 — 2026-10-15

PR427의 응답 body 회수·근거 full-page 이어 처리와 PR428의 설계 문서를 포함한 main
`8020dcae2e69f64922d71e8469fc86a5495399dc`를 M3·mini의13앱에 배포했다.
DDL 차이가 없어 migration은 실행하지 않았다. 기존 모델·발굴 중단·사람 판단·API reserve를 유지했다.
Oracle 신규 역할 배포나2배 성능 합격 기록은 아니다.

## 이미지와 실행 검증

수동 [CI38695981729](https://github.com/JRVector9/nomorevibe/actions/runs/38695981729)의
quality·통합3shard·필수check·양 image 발행이 모두 성공했다. Actions digest와 package metadata를 대조했다.

- Worker: `ghcr.io/jrvector9/nomorevibe-worker@sha256:5b4b1740caeb7271ce141fdba29df2d37b047d096dbd00031e056fe19f5ce54b`
- Web: `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:bd1d390c43fdead73470786e0613593848755b215bc2259296fbb3c00d766915`

main을 checkout한 detached worktree에서 `scripts/ops/deploy_shared_images.py plan/run`을 실제 실행해 exit0을 확인했다.
양 서버 private digest pull/arm64/OCI revision·웹 build/runtime 키 일치를 비밀값 노출 없이 검사했다.
publisher→reviewer→crawler 각각 mini예비→M3주, web mini→M3 순서로8앱을 전환했다.
매 앱의 새 deploymentID/done·실제image/release·healthy/replicas와 역할별 readiness/progress를 확인했다.
공개 health에서 `mini-web`·`m3-web` 양쪽이 같은 릴리스를 반환했고 HTML purge도 성공했다.

나머지 Git-source5앱은 원래 GitHub/main provider·command·env·build·복제수를 유지하고 RELEASE_TAG만 갱신했다.
maintenance와 text는 각각 mini→M3, scheduler는 마지막으로 배포했다.
최종 read-only verify에서5앱6컨테이너 모두 target release·healthy·runtime537파일 일치/누락0을 확인했다.
스케줄러2/2, 나머지 각1/1이다. Dokploy가 source commit metadata를 제공하지 않아 Git checkout 자체와
설치 dependency/toolchain provenance까지 증명한 것은 아니다. 코드 파일의 실제 SHA256 일치가 별도 증거다.

| 앱 | 새 deployment ID |
| --- | --- |
| maintenance-mini | xYy4pLxy_jkWtewC-aVOn |
| maintenance-m3 | _O_7aC8BnxmOZEhFyI009 |
| text-mini | xKDku2HaWqQ5hgGAtfDbF |
| text-m3 | -DrXH4Ya3g8kLu7Tfb9jT |
| scheduler-m3 | JUuUtssE2etaWK1BQeijv |

## 근거 보조 작업 인계

기존 보조 작업은 crawler-m3 컨테이너 내부 PID35683이었다. 교체 전에07:15:06Z 단일SIGTERM으로
정상 drain하고07:15:17Z zerohelper를 확인한 뒤23개 payload/state/log를 권한0600으로 export했다.
정상 워커가 공식 job lease를 다시 잡은 것은 강제로 해제하지 않았다.

새 crawler target 검증 후23/23파일hash와4공식export import를 확인하고 단일PID358로 재개했다.
07:26:54Z에는 원215cycle history가 새216cycle 장부의 byte-exact prefix임을 검증했다.
새 버전에서 보조 작업이 저장한29건은29개 현재입력·DB유효/오류0으로 별도 확인했다.
정상 크롤러의 저장을 보조 작업의 성과로 합산하지 않았다.

- 누적 cycle216 / attempted5580 / saved5372. 이는 source operation 수이며 고유제품 완료 수가 아니다.
- 원만료2026-10-17T03:22:09.892Z / max10000cycles / cycle180s / globalI/O1 그대로.
- 07:26Z due45228출처·22940제품, rawheld339. 전체적체 완료는 아니다.
- 재개 직후 정상 워커가 lease를 사용해 보조 작업은 공정하게 대기했다. 인위적queue/lease/schedule 변경 없이 나중에 진행했다.

## 복구 자료와 남은 관측

비밀값이 있는 스냅샷은 Git에 넣지 않았다.
공통8앱은 `/private/tmp/nomorevibe-release-8020dca-20261015-0719.json`,
Git-source5앱은 `/private/tmp/nomorevibe-pr00-source5-20261015/snapshot.json`이다.
보조 작업의 검증 자료는 사용자 private config의 `backlog-recovery/2026-10-15/pr00-helper-handoff/`에 보관했다.
이미 단일 재개했으므로 restore/start를 다시 실행하지 않는다.

source5 helper의 오프라인18테스트·Python/remotePython/Node구문, 기존 보조 작업41Node/6Python테스트를 실제 실행했다.
배포13앱 실제 동작 검증은 완료했지만24시간 관측·전체 근거적체 해소·고정입력 실모델30분 성능 비교는 아직 수행하지 않았다.
