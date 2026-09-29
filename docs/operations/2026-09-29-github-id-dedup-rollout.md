# GitHub 저장소 ID 중복 차단 운영 적용 — 2026-09-29

## 변경과 배포

`owner/name`이 바뀐 GitHub 저장소의 숫자 ID가 기존 원본과 같으면 새 원본·후보를 저장하지
않고 `crawl_frontier`를 `skipped`로 끝내며 `alias_of`에 기존 경로를 남긴다. 동일 ID 동시
저장은 트랜잭션 자문 잠금으로 직렬화한다. 기존 중복 원본·후보·제품은 삭제하지 않았다.

PR [#227](https://github.com/JRVector9/nomorevibe/pull/227)의 CI `check`와 GitGuardian이
통과했고 main 병합 SHA는 `f305a6b21d575c53af515ec0debd3e9f491460c7`이다.
운영 DB에 앱 마이그레이션 `0054_crawl_github_identity_lookup`을 직접 연결로 한 번 실행해
`crawl_frontier.alias_of`와 `crawl_documents_github_id_idx` 존재를 확인했다.
DB 서버·스트리밍·복제 설정은 바꾸지 않았다.

배포 순서는 crawler mini 예비 → crawler M3 주 → web mini → web M3였다. Dokploy 최신
deployment가 네 앱 모두 `done`이고 `Commit: f305a6b…`였다. 공개 `/api/health`를 여러 번
읽어 M3·mini 웹 모두 새 SHA와 `status:ok`, `db:ok`를 확인했다.

## 실행 검증과 한계

01:31 UTC 운영 DB에서 crawler 역할은 M3 주가 새 SHA로 lease를 소유했고,
`crawl-fetch`의 마지막 성공은 28초 전, `last_error`는 없었으며 프론티어의 `pending`과
`fetching`은 모두 0이었다. 문서는 108,669행이었다.

09:36 KST 첫 조회의 동일 ID 초과 원본은 304행이었다. 01:33 UTC(10:33 KST) 재조회는
300그룹·305행이었다. 추가된 1행 `opencosmos-ai/taoteching`은 새 릴리스 배포 전인
01:12 UTC에 수집됐고 기존 `shalomormsby/taoteching`과 숫자 ID가 같다. 배포 후
`alias_of`는 0행이었다. 즉 새 분기의 운영 실물 사례는 아직 없고, 로컬 경합 테스트와
CI 통과로 코드 경로를 검증한 상태다. 이후 새 이름 변경 별칭이 들어왔을 때
`alias_of` 증가와 동일 ID 원본 초과 행 불변을 함께 확인해야 한다.
01:35 UTC 재조회에서도 초과 행은 305개, 대기열은 0이었고 `crawl-fetch`·`crawl-seed`의
마지막 성공은 각각 20초·200초 전이며 오류 기록은 없었다.

로컬 새 통합 테스트는 수정 전 2개가 실패해 결함을 재현했고 수정 후 3/3 통과했다.
관련 통합 71/71, 전체 단위 1,257/1,257, 타입 검사·lint·Next 빌드·마이그레이션 검사가
통과했다. 로컬 전체 통합에서는 `product-audit.test.ts:163` 한 건이 실패했으나 변경 전
브랜치에서도 동일하게 재현됐다. GitHub Actions의 전체 통합과 빌드는 통과했다.

## 기존 자료

배포 전 조회에서 중복 ID 299그룹·초과 원본 304행 중 16그룹은 발행 제품이 둘 이상이었다.
이 자료는 심사·발행·사용자 지표와 연결되므로 자동 병합하거나 삭제하지 않았다.
대표 제품 선택, 기존 주소 리다이렉트와 지표 이관 기준을 정한 뒤 별도 작업으로 정리한다.
사용자에게 기존 발행 제품 자동 병합 범위를 질문한 상태다.
