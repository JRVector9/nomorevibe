# 2026-10-13 — 최근 8시간 스타 증가량 정렬과 목록 스타일

[PR #400](https://github.com/JRVector9/nomorevibe/pull/400)을 커밋·푸시·필수 CI 성공·일반 병합한 뒤 양 운영 웹에 배포했다. [홈](https://nomorevibe.com)과 [모두보기](https://nomorevibe.com/rising)는 **총 스타가 아니라 직전 8시간 회차 대비 순증가량**으로 정렬한다. 앞선 PR #398의 총 스타 후보 노출과 전일 비교 설명은 이 변경으로 대체됐다.

## 노출 기준과 화면

- 최신 마감 회차 T와 T−8시간을 비교한다. KST 00·08·16시 회차이며 실측 간격은 7~9시간만 허용한다.
- 스타 50~1,999개 중 순증가 1개 이상인 프로젝트만 노출한다. 증가량 내림차순, 동률일 때 관측 총 스타 내림차순, 고정 slug 오름차순이다.
- 기존 공개·생존·동일 저장소/연결 버전/GitHub 저장소 ID·관측 창/10시간 신선도 조건을 유지한다. 비교 자료가 없거나 실패하면 수집 상태를 표시하며 총 스타 순으로 대체하지 않는다.
- 제목은 ‘최근 8시간 스타 급상승’이다. **8시간 +153**을 주지표로 표시하고 **★ 801**은 작은 보조 지표로 표시한다. 실제 두 관측 시각과 수치는 툴팁·접근성 설명으로 제공한다. 현재 시각에서 실시간으로 거슬러 올라가는 8시간이 아니라 마지막 마감 회차 비교다.
- 모두보기는 기존 인기 목록의 경로·제목·요약·목록/카드 전환·저장·페이지 넘김·CSS를 재사용한다. 기본은 목록, `?view=cards`는 카드다. 페이지 이동은 회차와 보기를 유지한다.

관측 잡·8시간 수집 주기·immutable 수집 정책·schema를 바꾸지 않았다. 웹 reader의 비교 정책과 캐시 namespace만 8시간으로 바꿨다. 기존 카드/목록에 선택적 증가량 데이터만 전달하며 다른 목록의 스타 표시는 기존대로다.

## 실제 확인 결과

배포 후 공개 GET에서 홈 5개, 모두보기 목록 15개·카드 15개·2쪽 15개를 확인했다. 홈과 목록 첫 5개의 순서, 목록과 카드의 순서가 일치하고 증가량이 내림차순이며 페이지 간 중복이 없다. 총 스타 순서와 실제로 다르다는 것도 확인했다.

| 프로젝트 | 8시간 순증가 | 총 스타 |
| --- | ---: | ---: |
| ManimGX | +153 | 801 |
| skills-46 | +97 | 1,195 |
| mygo | +82 | 1,693 |
| baocut-2 | +70 | 818 |
| linkedin-agent | +54 | 1,905 |

ManimGX의 실제 운영 관측은 `2026-10-12T06:09:24.750Z` 648개 → `2026-10-12T14:09:38.628Z` 801개였다. 표의 값은 배포 확인 시점의 마감 회차이며 이후 회차에서 달라질 수 있다.

- 코드 head `a5050200f649664672ec13a95521c184f931091b`, 최신 base `bdc123864fd161b01d19132605d583b4c8dd003a`의 [PR CI 38298265219](https://github.com/JRVector9/nomorevibe/actions/runs/38298265219) completed/success, merge `de55c8e8182de49ad05cc23018f3c3b4bce4c25a`.
- [main CI 38298733079](https://github.com/JRVector9/nomorevibe/actions/runs/38298733079)의 타입·lint·단위·빌드·DB 통합 3묶음·check·이미지 발행이 실제 성공했다. 로컬 기능/E2E·실제 인증/댓글/스타 쓰기는 실행하지 않았다. 새 테스트는 추가하지 않고 기존 홈 fixture만 8시간 표기에 맞췄다.
- 운영 웹 release `de55c8e8182de49ad05cc23018f3c3b4bce4c25a`, private image `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:0cd4f78da5ea66b444f0d4cda9e9be74e9990956b2037840d810f64a3cf1c57a`.
- mini deployment `ude5h_-YOFmCdOZkdqJtn`, M3 `vaRvw9uANof4uJUb965QR` 모두 done. mini 2/2·M3 4/4 컨테이너 image/release·전체 saved/runtime env·health 일치. worker 6개는 release `33349ed1352caabcb434ac4906bc2a2213ac2a51` 유지·healthy다.
- 네 GitHub flags true/설정 일치·키·도메인·replicas·source·autoDeploy·명령·buildSecrets를 보존했다. 배포 전후 workerProgress/workerFailover ok와 소개 검수 `not_before=2100-01-01T00:00:00Z`/unleased를 확인했다.

운영자 디렉토리는 `/private/tmp/nomorevibe-star-growth-8h-release-20261013-cil525hy`다. target/verification/public-get/health/deployment-identities JSON은 비밀값을 제외한 확인 결과다. preflight/before snapshot은 비밀값을 포함할 수 있어 로컬 0700/0600으로만 보관하고 출력·공유·커밋하지 않는다. deploy는 한 번 완료했으므로 다시 실행하지 않는다. 문서 PR만으로 이미지를 재발행하거나 재배포하지 않는다.

상세페이지의 저장소 미수집 문구는 별도로 [운영 데이터와 표시 조건](2026-10-13-repository-facts-coverage.md)을 조사했다. 추가 요청의 [상세 정보 압축·업데이트 3개/모두보기 시안과 본문 제공 검토](../design/2026-10-13-detail-compact/README.md)도 별도 정적 문서로 완성했다. 시안은 운영 UI에 적용하지 않았다.
