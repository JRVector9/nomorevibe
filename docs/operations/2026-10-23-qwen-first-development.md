# Qwen 중심 제품 보강 개발 기록

설계 순번01~11의 구현을 진행한다. 기준은 main `c37ae82f`, 설계 문서 커밋은 `12fbf0bc`다. 운영 배포·DB migration·모델 서버 설정·자동 적용은 이 개발 기록의 완료 상태와 구분한다.

| 설계 순번 | 상태 | 브랜치 |
|---|---|---|
| 01 | 계약·프롬프트·오프라인 평가 구현·범위 검증 완료 | `feat/qwen-first-contracts-evaluation` |
| 02 | 직접 호출의 native capacity 연결 구현 중 | `feat/qwen-first-direct-capacity` |
| 03 | M1 사설 relay·설치물 구현 중 | `feat/qwen-first-m1-private-ingress` |
| 04·05 | 01·02 뒤 최우선 착수 | 아직 생성 전 |
| 06 | 기존 프롬프트·화면 근거 판 분리 구현 중 | `feat/qwen-first-qwen-screen-prompts` |
| 07~09 | 공통 work 준비 뒤 병렬 착수 | 아직 생성 전 |
| 10 | 비공개·기본 비활성 backend까지 개발, 노출은 제품 결정 뒤 | 아직 생성 전 |
| 11 | 전체 통합 뒤 정확한 SHA로 검증·운영 전환 기록 | 아직 생성 전 |

## 실행 환경과 검사

Node `24.22.1`, lockfile에 맞춘 `npm ci`를 사용한다. PR별 변경 범위 회귀·정적 검사와 필수 CI를 수행하고, 수동 전체 unit/DB/종합 검사는 통합 단계에서 한 번 수행한다. 테스트 DB는 이 작업이 새로 만든 격리 자원만 사용한다.

## PR01 구현 결과

- `localModelServingContractSchema`는 transport provider를 `local-direct`로 구분하고 검증된 서버 전체 문맥 상한을 C로 계량한다. `max_tokens`나 토큰 추정을 원격 보증으로 승격하지 않는다.
- `state/evidence_quality/action`과 원문 근거·DB raw revision·작성자 권한을 구분한다. 새 계약은 운영 경로에 아직 연결하지 않았다.
- 오프라인 평가는 입력/프롬프트/계약 hash·실제 responseModel·중복 응답·누락을 검사한다. 뉴스의 고정 사실 일치와 실제 요약 의미 정확도를 구분한다.
- 단위 검사3파일15개 통과. 실제 오프라인 CLI에 고정 파일을 입력해 결과를 확인하는 검사도 포함한다.
- 관련 ESLint와 `next typegen`·`tsc --noEmit --incremental false` 통과. 초기 평가 fixture의 literal type 오류는 수정 후 다시 검사했다.
- 이 결과는 새 운영 모델의 판정 정확도·실행 종료 계약·운영 연결 완료를 뜻하지 않는다. 물리 호출·도메인 적용은 뒤 PR에서 연결한다.

현재까지 운영 provider 호출·운영 DB 쓰기·서비스 설정 변경은 수행하지 않았다. 새 코드·기능의 준비 상태를 운영 활성화로 보고하지 않는다.

### PR-04 후보 큐 개발

llm_assist_controls/work/results 및 uptime 공통 helper 후보화를 구현했다. confirm 이후 확인 gate는 latched이며 소비 중단·off 전환이 legacy 즉시 내림으로 되돌아가지 않는다. shadow는 기존 내림을 유지한다. 원문 microsecond revision, 중복 후보 방지, SKIP LOCKED claim과 원 업무 pause를 격리 DB에서 검증했다. scoped DB 58건, ESLint·Next typegen·tsc 통과. 0118 후 migration journal 통합은 대기 중이다.

### PR-05 비동기 소비자

backend별 bounded drain과 native domain/binding·실제 terminal 대조, fresh 페이지 근거·최종 uptime CAS를 연결했다. GPU/M1 병렬 완료를 포함한 실제 DB/가짜 HTTP 13건 통과. 용량 대기 무시도·unknown 보존·pause·새 원시 revision·관리자 해제 보호를 확인했다. source별 input snapshot도 결과에 남긴다. 원격 실모델 품질·운영 허용 기준은 미검증 상태이며 기본 off다.
