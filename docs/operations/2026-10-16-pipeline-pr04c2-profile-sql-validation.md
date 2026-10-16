# PR453 replay profile SQL 개선 검증

원 handler 인증이 매번 수행하는 이름 해석 왕복과 사용하지 않는 상세 binding 생성을 줄인다. 인증 결과·빈도·권한·stored manifest·정책 hash·시간제한은 유지한다. CI의 33–45초 item 지연을 로컬에서 재현하지 못했으므로 timeout 해결 완료로 판정하지 않는다.

## 구현과 리뷰

- public 고정13 이름의 unqualified to_regclass를 하나의 SELECT로 읽고 길이·중복·이름별 OID를 모두 비교한다. search_path/shadow 방어를 보존한다.
- 모든 non-system 관계의 table/column/sequence/owner/PUBLIC 및 grantable 권한 검사는 계속한다. 상세 column/default/trigger/function binding만 허용26관계에 생성한다.
- policy/version/hash, assertObjectPolicy, provision/verify 공개 함수 본문 byte 동일. 캐시·검증빈도·journal/ACK·lock/wall·driver 기대·20초 제한 변경0.
- root 직접 source/conformance 읽기와 C 독립리뷰에서 추가 P1/P2=0. 최종 source SHA e28855fa3e5eb1a4ccad44cd184a30e8a82648aed2fe53308c8f6b2985bf324d.

## 실제 실행 결과

B의 전용 loopback55535에서만 실행했다. 원본 provision이 실제 저장한 v5/v6 manifest를 새 verifier가 승인하고 원 verifier와 같은 native session을 비교했다.

- old/new 실제 권한·shadow·guard·manifest 대조32항목 PASS/exit0. 음성 후 원복·재승인 및 manifest26객체/guard OID·정의 전후 exact.
- 기존 legacy/item 두 case 각각1회: 2PASS/12skip, tests12.72초/전체13.41초/exit0.
- 단독 profile eslint·scoped tsc exit0. 수동 전체suite/build/typegen 실행0. 모든PR개발후 전체통합검사 예정.
- 임시 계측 baseline은 legacy7.115초/item9.479초, 이번 phase4.933/6.816초이나 서로 다른 단일실행이다. cache/load/계측을 통제하지 않았으므로 향상률·성능 인과를 인증하지 않는다.

원명령·로그: /tmp/nomorevibe-pr453-b-profile-opt-final-report-20261016.md, ...profile-opt-conformance-20261016.ts/.log, ...profile-opt-conformance-summary-20261016.json, ...profile-opt-original-pair-20261016.log. 독립읽기리뷰 ...pr453-c-profile-independent-review-20261016.md.

## 실패 접근과 정리

첫 native array 바인딩은 fetch_types:false serializer 부재로22P02 setup실패. 실제 자기 OID/nonce/identity/active0 확인 후 기존 profile cleanup으로 복구했으며 기능RED로 세지 않는다. scalar JSONtext로 바꾼 뒤 실제 검증·정리 정상이다. /tmp scoped tsc의 첫 Node types 탐색 오류는 typeRoots만 고쳐 같은 source exit0, 원진단 보존.

root가 exact container/loopback/pinned image/768MiB 확인 후 별도 client로 독립 readback하여 B after와 exact를 확인했다. public85/raw7행 µs exact, catalog122의 OID/owner/kind/RLS/trigger 및 effective ACL·schema/role exact, 다른 연결0. raw relacl17/datacl의 NULL→명시 default 표현 차이는 false로 보존했다. catalog 정규화 DML0. 정상STOP/exited0/OOMfalse 확인 뒤 자기container/volume만 제거했다.

증거: /tmp/nomorevibe-pr453-root-profile-opt-readback-proof-20261016.json, ...pr453-root-profile-opt-cleanup-20261016.json. 55535는 retired이며 재접속하지 않는다. 운영DDL·배포·실모델 호출·활성화0.
