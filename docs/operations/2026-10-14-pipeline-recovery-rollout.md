# 수집·검수 개선과 관리자 크롤러 활동 — 배포 기록

## 목표와 범위

사용자가 로컬 변경의 푸시·운영 배포·마이그레이션과 모든 크롤러의 관리자 활동 표시를 지시했다.
기존 수집 복구·유입 제어·근거 수집 재개/캐시·실행 줄 감시, 한국어 소개 품질 거절 카운터와
관리자 `크롤러 활동` 탭을 함께 배포한다. X 코드는 기본 dry-run 수동 API 파일럿이며 상시 수집이나
공개 HOT 필터는 이번 배포에 포함되지 않는다. 사용자 중단 소개 검수는 재개하지 않는다.

## 배포 전 실제 확인

- 최신 main `91685ca`를 작업 브랜치에 충돌 없이 병합한 `45de7d0`에서 의존성을 다시 설치했다.
- 운영 13개 앱이 Dokploy done, 실제 컨테이너 ready임을 읽기 전용으로 확인했다.
  웹 mini2/M3 4, 역할별 주·예비 각각1, scheduler2복제본을 유지한다.
- 운영 DB journal76, `quality_rejections` 컬럼 없음, 소개 검수 `not_before=2100-01-01`, lease 없음.
- 최신 base 통합 뒤 단위254파일2,434사례와 통합143파일1,546사례(464/444/638)가 통과했다.
  기존 todo1은 실행하지 않았다. 통합 전용 로컬 PG17/pgvector0.8.6 세 DB를 사용한 뒤 모두 중지했다.
- Python 배포 도구23검사, CI scope4검사와 Next typegen이 통과했다.
- 관리자 탭 최초 freeze의 전체 단위256파일2,453사례, TypeScript·i18n·lint·production build가
  통과했다. 공개 번들148.6/158.9/136.1KB(br)는 모두 기준선의10% 한도 안이다.
  lint는 기존 vendor 미사용 변수 warning1개만 남았다. 아래 리뷰 수정 이후 최종 검사는 별도로 기록한다.
- 독립 읽기 전용 리뷰는 수집·취소·워커·마이그레이션에서 추가 P0/P1/P2를 발견하지 못했다.
  해당 담당의 선택 단위10파일131사례도 통과했다. 설치되지 않은 gstack 체크리스트를
  실행했다고 기록하지 않으며 저장소 runbook과 독립 코드 리뷰로 검증한다.

### 마지막 관리자 리뷰의 회귀 수정

네이티브 독립 리뷰는 저장된 failed/partial 스캔의 문자열 상태가 관측에서 제거돼 성공으로 표시되는
문제를 재현했다. 안전한 boolean 실패 신호를 남기고 과거 신호 없는 스캔은 결과 미확인으로 표시한다.
루트 직접 CLI 백엔드 리뷰는 `No findings / CONCLUSION: OK`였다. 관리자 CLI 리뷰는 오래된 예비 관측이
새 실행을 가리는 경우와 항목 실패0이 별도 요청 오류를 숨기는 경우를 실제 모양으로 재현했다.
두 표시 경계와 최신 release 메타데이터를 회귀 RED→GREEN으로 수정했다. 최종 집중5파일59검사와
전체256파일2,468단위·Next typegen·TypeScript·i18n·lint·diff 검사가 통과했다. 최종build/bundle도exit0이고 독립 최종 재검토는CLEAN, 같은집중59검사를별도로실행해통과했다.
직접CLI최종수정followup도exit0/No findings/OK였다 (in-memory42검사, Vitest미실행). CLI의 read-only 모드에서 Vitest는 임시 디렉터리 생성 제한으로
시작하지 못했으며 CLI가 실행한 테스트로 계산하지 않는다.

## 관리자 표시 범위

기존 운영센터의 관측·작업·처리량·역할 lease 조회를 재사용한다. 모든 crawler 역할 카탈로그 작업과
다른 역할의 사이트 응답·뉴스·이미지·저장소 재확인을 포함한다. 현재 실행과 예비 대기, 관측 지연,
사람의 중단, 재시도 유예, 요청 대기와 실행 없음이 구분된다. 결과는 안전한 숫자·상태만 표시한다.
기존 관측 저장소는 직전 값을 교체하므로 `수집기별 최근 실행`은 각 수집기의 마지막 저장 회차다.
전체 과거 로그나 측정하지 않은 대기·오류 건수를 추정하지 않는다. 새 DB 조회/마이그레이션은 없다.

## 운영 적용 상태

관리자48f25c2커밋을push하고[PR#416](https://github.com/JRVector9/nomorevibe/pull/416)을생성했다.
첫CI38549253859는quality/integration1,2성공, integration3의GitHubdeadline검사1건실패였다.
내부deadlineAbortSignal이wall deadline보다먼저취소돼도hasBudget이외부signal만검사하는조건을
고정적RED로재현했다 (deadline실패/외부abort성공). combined신호를검사하는최소소스수정후
같은두검사가GREEN이며, hanging요청진입·취소원인·빠른반환·늦은응답뒤쓰기없음을검사한다.
관련통합103개와type/scopedlint/diff, 루트전체2,468단위/lint/build/bundle가다시통과했다.
native와directCLI최소diff재검토는CLEAN/OK였다. 후속PR CI38550569220 전체성공 뒤
PR#416을 정상 병합했고 main은 `cb6b719e5222064c0657b36d2b45a0efd573ff93`이다.
main CI38551249622도 필수check와 양 이미지 발행까지 성공했다.

13앱 설정 보존·양 서버의 새 이미지 pull·웹 빌드키 일치 preflight 뒤11워커 서비스를 drain했다.
새 worker image로 직접5432 DB의 migration0076을 실행해 exit0을 확인하고 복제본을 복구했다.
journal77, integer/NOTNULL/default0와38,593행의 보수적 backfill mismatch0/invalid0,
소개 검수2100-01-01·미임대 보존을 확인했다. text-mini/text-m3는 cb6b719의 실제 컨테이너가 ready다.

text 뒤 전체 monitor gate에서 evidenceProgress SQL이3초 statement_timeout(code57014)에 걸렸다.
전체 역할 readiness와 scheduler2복제본 생존은 정상이며 나머지11앱은 이전 정상 릴리스로 유지했다.
읽기 전용 진단 EXPLAIN ANALYZE는4,411.656ms: 근거246.854ms, agent1,439.238ms,
AI2,724.212ms다. public43,958개에서 주소 정규화 계산이 지배적이며 디스크 임시 spill은 없었다.
운영3초 한도와 gate를 보존해 `ai_public AS MATERIALIZED`로 정규화를 한 번만 계산한다.
같은 입력 시각·파라미터의 읽기 전용 A/B는4,395.517→2,695.092ms, 세 집계 결과 전체 동일이었다.
수정 쿼리는 실제3초 한도에서 성공했고 EXPLAIN2,770.851ms였다. 여유 약300ms인 관측이므로
추가 성장이나 다른 부하에서도 항상3초 이내라고 보장하지 않는다. 진단만 읽기 전용12초 한도를 썼다.
긴 유효 저장소 주소80,000개/current 버전/미발견 idle 회귀에서 기존 쿼리57014 RED를 재현하고
같은3초 제한의 수정 쿼리가 두 차례 GREEN이었다. 관련 두 파일 통합37/37와 파일 lint가 통과했다.
독립 읽기 전용 native와directCLI검토는CLEAN/OK였다. 후속PR#417의CI38557315298에서는
quality/integration1,3이 성공했으나 integration2의 새80k 회귀가57014로 실패했다(나머지444사례성공).
단일MATERIALIZED의 여유가 충분하지 않아 PR을병합하거나 추가배포하지 않았다.
같은3초/80k기준을 보존하면서 canonical GitHub URL만 문자열 추출로 계산하고 나머지는 기존 mode별
정규화를 그대로 fallback한다. 실제 helper의14,407개 주소 변형을 원래 두 식과 DB에서 비교해 차이0을 확인했다.
같은 snapshot·파라미터의 운영 읽기 전용 A/B4,313.499→1,082.249ms/전체 집계 동일,
수정 쿼리의 실제3초 한도 성공과 EXPLAIN1,202.197ms를 확인했다.
관련38통합·두파일lint·TypeScript 및 CI=true/TZ=UTC의 전체shard2(48파일446사례)가 통과했다.
native후속리뷰도CLEAN이다. 직접CLI/새PR CI를 확인한 뒤 배포를 재개한다.
13앱 릴리스 일치·실제 소스hash·양웹·인증 관리자 읽기는 아직 완료하지 않았다.
원래 private baseline은 보존하고 현재 혼합 릴리스용 별도 snapshot을 준비한다.

운영 절차는 소비자 drain → 새 worker image로 직접 DB 마이그레이션0076 한 번 실행/검증 →
기존 복제본 복구 → 역할별 mini 예비/M3 주 순차 교체 → 양 웹 교체 → 실제 DB·워커·HTTP 확인이다.
환경·명령·복제본·키·기능 플래그를 보존하고, 0600 설정 스냅샷은 저장소 밖에 보관한다.
DB 서버·스트리밍 설정·X 토큰 주입·외부 메시지 전송은 변경하지 않는다.

## 남은 운영 관측

배포 성공과 처리 용량 목표 달성은 별개다. 근거 성공/partial/due·최장 지연·304 비율·API quota와
신규 수집 지연을 후속으로 측정한다. 24시간 안정성·외부 monitor 수신·X 목적 승인 및 상시 일일
예산·프로젝트 연결 품질·공개 HOT는 별도 미완료 항목으로 유지한다.
