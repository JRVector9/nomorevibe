# 공개 CI와 제품 README 복구 — 2026-09-27

README가 비어 있던 공개 제품 12,418개를 실제 GitHub 원본에서 다시 확인해 **10,630개의 내용을 저장했다**.
재수집 결과를 제품 검색 입력에도 반영했다. 홈페이지 재수집이 README를 지우는 원인도 수정했다.

## 실제 수집·저장 결과

| 결과 | 제품 수 | 처리 |
|---|---:|---|
| README 획득 | 10,630 | 원본 문서와 제품 검색 입력 저장 |
| 공개 저장소에서 README 미발견 | 1,766 | 내용 생성 없이 미발견으로 기록 |
| 사용 가능한 정제 텍스트 없음 | 21 | 이미지 중심 문서 등을 빈 발췌와 구분해 집계 |
| 외부 접근 제한 | 1 | GitHub HTTP 451, 저장 성공으로 집계하지 않음 |
| 일시적 실패·API 대기 잔여 | 0 | API 제한 해제 뒤 재시도 완료 |

대상은 실행 시작 시점의 공개 제품 중 README 입력이 없고 저장소·원본 문서 연결이 있는 제품이다.
복구 후 읽기 전용 DB 대조에서 획득 10,630개 모두 여전히 공개 상태였고,
원본 발췌 누락 **0**, 제품 입력 누락 **0**, `left(readmeSample, 2000)` 복사 불일치 **0**이었다.
마지막 대조 시 원본 대상 밖의 신규 공개 제품에서 추가 누락 대상도 없었다.
접근 제한 저장소는 [nomaan5541/motionsites-prompt-collection](https://github.com/nomaan5541/motionsites-prompt-collection)이다.

일회성 복구는 4개 네트워크 작업으로 진행하고 GitHub API fallback은 직렬로 실행했다.
API quota가 소진된 항목은 대기 상태로 기록하고 reset 후 새 실행에서 재시도했다. 다른 토큰으로 제한을 우회하지 않았다.
README 전체를 DB에 넣지 않는다. 최대 256 KiB를 읽어 정제된 3,000자 발췌를 문서에,
최대 2,000자를 제품 검색 입력에 저장하는 기존 정책을 적용했다.
문서의 ID·수집 시각·메타데이터가 그사이 바뀌면 덮어쓰지 않는 비교 조건을 사용했다.

## 재발 방지와 검색 처리

- [PR204](https://github.com/JRVector9/nomorevibe/pull/204): 큰 README는 허용된 크기까지 읽고 스트림을 취소한다. 일반 근거 수집의 크기 초과 실패 정책과 SSRF·시간 제한은 유지한다.
- [PR206](https://github.com/JRVector9/nomorevibe/pull/206): 홈페이지를 재수집할 때 마지막 README만 보존한다. 오래된 홈페이지 내용은 새 값으로 교체한다. README 확인 version을 무효화한 공개 제품은 crawler가 5분마다 최대 2개, 저장소당 8초/전체 20초 예산으로 재확인한다. 원본 비교와 잡 소유권을 같은 트랜잭션에서 검사한다.
- 공개 여부를 확인하지 못하거나 네트워크·API 오류가 나면 마지막 README를 유지하고 재시도를 늦춘다. 공개 저장소의 README 미발견을 확인한 경우에만 빈 값으로 바꾼다. 비공개·접근 불가 저장소의 404를 README 삭제로 오인하지 않는다.
- [PR201](https://github.com/JRVector9/nomorevibe/pull/201): 감시 작업이 읽기 전용 스냅샷에서 원본 해시와 검색 사본을 대조하고 관리자 상태에 완료 관측을 저장한다. 웹 요청에서 전체 DB를 스캔하지 않는다. 성공 생성 시각은 재사용 시각과 구분한다.
- [PR203](https://github.com/JRVector9/nomorevibe/pull/203): `invalid_output`·timeout 재시도는 키워드 5개씩 나눠 엄격히 확인한다. 같은 전체 deadline을 사용하고 모든 묶음이 성공해야 저장한다. 기존 소스/버전/소유권 검사와 backoff를 보존한다.

README 추가 입력이 원본을 바꿨으므로 검색 키워드는 정상적으로 재생성 대기에 들어갔다.
10:46 KST 읽기 전용 검사에서 전체 공개 제품 19,354개, 프로필 누락 0,
갱신 표시 없는 해시 불일치 0, 검색 사본 불일치 0, 생성 대기 10,265, 검수 대기 25였다.
최근 구간 생성 86/검수 77, 생성 유휴 0분으로 작업이 진행 중임을 확인했다.
과거 키워드에 새 해시만 덮어씌워 완료로 꾸미지 않았다. **README 입력 완료와 키워드 재생성 완료는 다르다.**
수집·AI 심사·생존 확인의 실제 성공 시각도 진행 중이었다. 사용자가 중단한 소개 검수는 재개하지 않았다.

## 공개 저장소·CI·의존성

main은 관리자에게도 PR, 최신 base의 필수 `check`, 리뷰 대화 해결을 요구하고 강제 푸시와 삭제를 막는다.
Secret scanning·push protection·Dependabot 보안 업데이트를 활성화했으며 09:50 KST 공개 API 조회에서 열린
secret alert와 Dependabot alert는 각각 0이었다. 이는 모든 미래 보안 문제의 부재를 보장하는 결과가 아니다.

[PR202](https://github.com/JRVector9/nomorevibe/pull/202)는 Next/eslint-config-next 16.3.3,
sharp 0.35.4, Vitest 4.1.11과 esbuild/js-yaml 패치를 반영했다. `npm audit` 0과 의존성 트리 검사를 확인했다.
M3/mini의 실제 웹 컨테이너에서도 Next 16.3.3/sharp 0.35.4를 읽어 확인했다.

[PR205](https://github.com/JRVector9/nomorevibe/pull/205)는 CI에 수동 실행, 읽기 권한,
같은 PR/ref의 이전 실행 취소, 20분 제한을 추가한다. 공식 checkout 7.0.1/setup-node 7.0.0의
Node 24 action manifest와 고정 SHA를 확인했다. 필수 check 이름과 PostgreSQL 17 통합 테스트 순서를 유지한다.
README·AGENTS·PENDING의 과거 미배포 상태를 실제 운영 상태로 교정했다.

## 실제 검증과 배포 근거

| 검증 | 실행 결과 |
|---|---|
| README 보존 회귀 | 이전 구현에서 실제 실패 후 수정, crawl-fetch 25개 통과 |
| README refresh 소유권·소스·backoff | PostgreSQL 통합 5개 통과 |
| 비공개/접근 불가 404 보존 | 실제 회귀 실패 후 수정, 관련 단위 8개 통과 |
| PR206 최종 hosted CI | [36286197257](https://github.com/JRVector9/nomorevibe/actions/runs/36286197257), 단위 1,197개/150파일, 통합 886개/90파일 통과·todo 1개 |
| 타입·lint·빌드 | PR206 최종 hosted CI 모두 통과; lint 기존 경고 1개 |
| 독립 CLI 리뷰 | cap 뒤 끝나지 않는 스트림, 발행 제품의 재확인 경로 누락, repo 404 오인 지적을 수정하고 최종 focused review에서 추가 지적 없음 |
| 감시용 migration | 0049·0050 실제 운영 실행 exit 0 |
| 감시 전체 대조 | 19,354개/2,703ms, 읽기 전용; 미표시 해시·사본 불일치 각각 0 |
| 감시 정상 잡 | 실제 maintenance 소유 실행과 완료 관측 확인 |

PR202/PR201은 각각 소스 커밋 `47cbbd4`/`973eef2`로 8개 앱의 배포 완료를 확인했다.
README·chunk 수정까지 포함한 `801039a58e4b0944c124a61609073332152082db`는 10:46 KST 배포 요청 뒤 8개 앱 모두 해당 소스 커밋의 `done` 상태를 실제 확인했다.
PR205의 최종 CI/병합, main 수동 CI, 마지막 소스 배포와 서비스 확인은
이 보고서 작성 뒤 실행하는 단계이며 최종 인계 기록에서 실제 결과를 확인해야 한다.

배포 후 정상 `product-readme-refresh` 잡 requested/processed 1/1, 성공 시각 01:47:55 UTC를 확인했고,
공개 홈페이지 HTTP200(1.75초)를 확인했다.

실행하지 않은 검증은 관리자 화면의 실제 시각 QA, 운영 백업 복원, 24시간 연속 관측, 랭킹 정책 시즌 전환이다.
[PENDING.md](../../PENDING.md)에 후속 운영 검증을 보존했다. 일회성 복구의 상태·집계에는 원문 README나 토큰을 넣지 않았다.
