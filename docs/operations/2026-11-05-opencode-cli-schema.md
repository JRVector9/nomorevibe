# OpenCode 검수 CLI · 0163 스키마 검토

0163은 관리자에서 OpenCode 연결을 저장하고 AI 1차·2차 검수의 기존 CLI 장부를 사용할 수 있게 하는 가산 변경이다. 운영 DB 적용·모델 호출·실제 배정·용량 설정 변경은 이번 개발에서 실행하지 않았다.

## 변경하는 제약

| 이름 | 변경 |
| --- | --- |
| `ai_connections_cli_check` | 기존 null·모델 목록 조건을 유지하며 `cli_tool`의 허용 값에 `opencode` 추가 |
| `model_capacity_requests_logical_check` | 기존 rules 뒤에 OpenCode AI1/AI2의 정상·근거 있는 withdrawn 논리키 가지 추가 |
| `model_capacity_requests_dispatch_check` | `ai1_legacy_cli`, `ai1_item_cli`, `ai2_item_cli`에만 OpenCode provider/transport를 허용하는 가지 추가 |
| `model_capacity_events_terminal_check` | 위 검수 binding의 동일 요청·transport·C·물리 종료 증명을 검사하는 이벤트 가지 추가 |

장부의 큰 CHECK는 0160 이후 `model_capacity_check_rules`와 guard 함수로 관리한다. 기존 술어·순번을 고치지 않고 다음 ordinal을 추가한 뒤 두 표의 guard 함수를 재생성한다. 요청의 terminal 검증은 provider enum을 고정하지 않고 원래 요청·binding·transport·C를 비교하므로 그대로 사용한다. 실제 OpenCode settled 행도 이 기존 terminal 규칙을 통과함을 확인했다. members와 events kind 규칙도 변경하지 않는다.

`scripts/ops/generate-opencode-cli-sql.ts`는 마지막 정적 전체 CLI 선언인 0125에서 관련 기존 술어를 추출한다. 추가 가지에서 reviewer/transport enum만 OpenCode로 치환하고 OpenCode provider·검수 kind/route 조건을 더한다. 감사·소개 검수·Grok 세션·발행 분류의 provider 고정 조건은 유지한다. 생성된 값은 스키마 상수와 0163 SQL 양쪽에 동일하게 들어간다. 과거 migration 파일은 수정하지 않았다.

## 보존하는 운영 계약

- 완전한 JSON 키 목록, 요청·owner·잡/아이템 토큰·epoch·logical key·모델·해시·C 조건을 유지한다. enum을 모두 허용하는 일반 실행 경로를 만들지 않는다.
- 물리 종료 증거 없는 withdrawn, 잘못된 transport/model/owner/route, 예산 C 축소, 검수 이외 타깃은 계속 거절한다.
- 0134~0137의 executor/removed/indeterminate 복구 계약은 발행 분류 전용이다. 이 계약의 transport enum을 기존 값으로 고정해 전역 CLI provider 추가가 복구 권한이나 과거 JSON snapshot을 바꾸지 않게 한다.
- `model_serving_contracts`의 DB 조건은 route/model 일치·해시·인증 조건이다. 새 declared 계약을 위해 이 조건을 바꿀 필요는 없다. 추론 강도는 기존 모델 options 및 argv 해시에 반영되며 새 DB 열을 만들지 않는다.

## 적용 경계와 잠금

[일반 배포 절차](deployment-fast-path.md)의 모델 호출 보유 앱 교체·장부 변경 경계를 따른다. 운영 적용은 root가 별도 이전 창에서 진행한다. 공식 비교 후 적용 경로로 DRAINING을 확인하고 유효 reserved·dispatched가 모두 0인지 확인한다. 실제 배포 관문의 `MODEL_REPLACEMENT_SCRIPT`와 `lib/llm/capacity-states.ts` 기준으로 indeterminate는 슬롯을 보유하지 않는 별도 사람 확인 대상이다. 미확정 행 수·경보는 따로 보존하며 이를 배포를 위해 지우거나 모델을 강제 종료하지 않는다. 기존 일반 문서의 indeterminate=0 문구를 현행 관문의 의미로 해석하지 않는다.

0163은 `lock_timeout=5s`를 사용한다. `ai_connections`의 작은 CHECK 교체·검증에는 ACCESS EXCLUSIVE 잠금이 필요하므로 해당 표의 동시 쓰기를 잠깐 막을 수 있다. rules 표는 SHARE ROW EXCLUSIVE로 동시 변경을 막고, 기존 장부 전체를 다시 스캔하거나 큰 CHECK를 재설치하지 않는다. 두 guard 함수 교체의 메타데이터 잠금도 별도 이전 창에 포함한다. 잠금 실패·예상과 다른 사전 상태는 트랜잭션을 실패시킨다.

각 대상은 0160 baseline이 정확히 1개이고 0163 source가 없는지 먼저 확인한다. 삽입 후에는 새 source가 정확히 1개이며 술어 SHA256이 생성한 값과 같은지 검증한다. baseline 누락·중복 적용·부분 적용·술어 변조를 조용히 건너뛰고 journal만 성공시키지 않는다. 실제 재실행은 정상 migrator의 journal로 건너뛰며, SQL을 수동 재적용하면 사전 조건에서 중단한다.

적용 성공과 journal latest/count/hash를 확인한 뒤 해당 릴리스의 앱을 공식 경로로 교체한다. 실제 OpenCode 실행 파일·버전 probe·승인된 declared 계약이 준비되기 전에는 새 배정 활성화 완료로 보고하지 않는다. 운영 실데이터나 기존 모델 순위를 이 migration이 자동으로 바꾸지 않는다.

## 개발 검증 기록

- 정적·이력 검사 4파일 18개 통과: 새 가지와 스키마 일치, 제약 범위, 과거 적용 migration 해시, 기존 분기 보존, 0134~0137 JSON snapshot 보존.
- 로컬 전용 PostgreSQL 임시 테이블에서 7개 회귀 통과: Claude/Grok 기존 정상·거절 판정, OpenCode AI1 legacy/item·AI2 dispatch/terminal, 위조 거절, connection 조건, settled/indeterminate·withdrawn 경계.
- fail-closed 보강 뒤에는 새 사전/사후 검증만 별도 실행했다. baseline 누락/중복, 신규 source 중복, 추가 술어 누락/변조/중복을 임시 rules 표에서 거절한다.
- 최종 migration 전체도 독립 임시 스키마의 기존 rules에 적용하여 앞선 술어 바이트 보존과 신규 3개 가지·guard 함수·connection CHECK를 확인한다. 실제 운영 DB 적용을 뜻하지 않는다.
- 초기 정적 테스트에서 JSON route 문자열의 따옴표 기대치 2건, PG fixture에서 JSON 인자 이중 직렬화 6건이 실패했다. 기대치와 `::text::jsonb` 전달을 수정한 뒤 해당 검증은 통과했다. 전체 unit/DB/모델 호출은 실행하지 않았다.


## 설치 CLI 변경 호환 (2026-11-06)

OpenCode는 특정 버전 번호로 실행을 고정하지 않는다. 설치된 실행 파일의 실제 경로·파일 식별자가 바뀌면 `--version`과 도움말을 다시 읽고, 지원되는 `--pure`·`--standalone` 및 추론 강도 인자 형식을 선택한다. 기존 v1 인자와 v2의 `model#variant` 형식을 지원하며, 지원하지 않는 호출 형식은 준비 단계에서 오류로 남긴다.

인증은 기존 `jr`의 XDG 데이터 경로를 그대로 사용한다. 인증 파일을 읽어 키를 복사하거나 CLI를 설치·갱신하지 않는다. v2 모델 목록과 추론 강도는 임시 소유 서버의 `/api/model` 메타데이터에서 읽고, 로컬 서버 인증용 난수는 메모리에서만 사용한다. 조회가 끝나면 해당 서버의 stdin 소유권 연결을 닫는다.

OpenCode 실행 계약은 인증된 호스트에서 최근 관측한 버전을 사용한다. 저장된 계약의 버전만 달라졌다는 이유로 모델을 다시 저장하도록 요구하지 않으며, 실제 버전은 메모리의 계약과 argv 해시에 결박한다. 관측이 없거나 낡으면 새 실행을 허용하지 않는다. 다른 CLI의 버전 검증, 모델·장비 한도, 종료 증거와 승인 검증은 유지한다.

같은 호출·응답 규약을 지원하는 CLI 업데이트는 이 탐지 경로를 통해 반영되므로 버전 번호 변경만으로 코드 배포를 반복하지 않는다. 호출·응답 규약 자체가 달라진 경우에는 오류 근거를 확인하고 호환 여부를 검토한다. 이번 개발에서 실제 M3의 CLI 2.2.5 메타데이터와 기존 인증을 이용한 Go DeepSeek 모델·추론 강도 조회를 확인했다. 운영 검수 추론·배포 완료를 뜻하지 않는다.
