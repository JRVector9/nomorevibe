# PR-01 — LAYA 설치형 제품 힌트와 비교 평가

브랜치: `feat/laya-speculation-evaluation`. 상태: 구현·CI·실제 LAYA 인증 호출 확인 완료. 새 표본 100개 실제 평가 완료, 운영 효과 검증은 남아 있다.

## 구현 범위

- `lib/crawl/laya-preview.ts`: 설치형/500별 이상만 단일 yes/no 질문. LAYA `POST /v1/systemone`, `model:auto`. 반환 타입은 힌트 전용이며 ReviewOutcome과 호환되지 않는다.
- `lib/crawl/laya-evaluation.ts`: 제한된 JSON 입력 검증, 기존 첫 심사 모델과의 결과 비교, 동일 입력 중복 검출, 관측/가정 구분.
- `scripts/evaluate-laya-speculation.ts`: 명시한 로컬 JSON만 읽고 새 결과 파일에 저장. DB 접근 없음. 기본 dry-run, `--live`에서만 API 호출. 건수 상한 100, 호출 순차, 전체 시간 상한, 실패 재시도 없음.
- 테스트: HTTP 계약·timeout/abort/응답 크기·인증/리다이렉트·잘못된 출력·입력 불변·대상 범위·평가 통계.

LAYA_URL/LAYA_API_KEY는 서버 환경 변수만 사용한다. URL 인증정보/query/hash/path 금지, redirect 금지, HTTP 오류 본문/키/예외 원문은 결과·로그에 남기지 않는다. 입력은 프로젝트 설명/README의 한정된 사본만 사용하고, 기존 심사 원문을 수정하지 않는다. 이 발췌는 힌트용이며 후속 심사 근거로 사용 불가.

## 효과 평가

평가 입력은 기록된 ReviewSnapshot과 첫 모델의 결과, 가능하면 첫/둘째 모델 순수 실행 시간이다. 출력은 대상 수, 양성 힌트 수, 첫 승인과의 일치/불일치, 첫 비승인에 대한 낭비 후보, 오류, latency, 누락 시간 수다. 기존 모델 답을 사람의 정답으로 표시하지 않는다.

시간 정보가 모두 있으면 `min(max(firstMs - layaMs, 0), secondMs)`를 이상적인 여유 슬롯에서의 최대 겹침 시간으로 계산한다. 큐·준비·DB·경합 비용이 제외된 **조건부 상한**이다. 실제 절감이나 SLA가 아니다. 시간 없는 행을 0ms로 채워 평균을 왜곡하지 않는다. 운영 적용 가능 결론을 자동으로 출력하지 않는다.

PR-02 진입에는 미사용 실제 후보 표본, 공유 gateway 여유 슬롯, 선행 계산 비용 대비 이득이 필요하다. 단순히 LAYA 30ms가 첫 모델 10초보다 빠르다는 이유로 통과시키지 않는다. 첫 모델은 계속 실행된다.

## 검증 명령

```sh
npx vitest run tests/laya-preview.test.ts tests/laya-evaluation.test.ts
npx tsc --noEmit
npx eslint lib/crawl/laya-preview.ts lib/crawl/laya-evaluation.ts scripts/evaluate-laya-speculation.ts tests/laya-preview.test.ts tests/laya-evaluation.test.ts
git diff --check
```

실제 호출 시 프로세스 환경에 키를 설정하고 `--live`를 사용한다. 결과 파일에 원문/키를 복사하지 않는다. 기존 sample을 사용한 평가는 회귀 점검이며 holdout 검증으로 부르지 않는다.

## 실행 방법 / 실제 검증 결과

입력 모양은 [가상 예시](../../operations/evaluations/2026-09-21-laya-speculation/input.example.json)를 참고한다. `snapshot`은 기록된 ReviewSnapshot을 그대로 넣을 수 있으며 필요한 필드만 읽는다. `first.durationMs`, `secondDurationMs`에는 **순수 모델 시간만** 넣는다. 큐·준비·저장 포함 시간 또는 없는 시간은 `null`로 둔다. 입력 파일 최대 2MiB, 1~100건, 전체 55초·개별 최대 500ms, 재시도 없음. 결과 파일은 기존 파일을 덮지 않고 권한 0600으로 생성한다. 취소/일부 실패는 보고서에 표시하며 CLI가 성공 종료로 숨기지 않는다.

```sh
# 기본값: 네트워크 없는 입력·보고서 점검
npx tsx scripts/evaluate-laya-speculation.ts --input docs/operations/evaluations/2026-09-21-laya-speculation/input.example.json --output /tmp/laya-example-new.json

# 실제 평가: 이미 설정된 비밀 환경 파일의 경로만 사용
node --env-file=/absolute/path/to/laya.env --import tsx scripts/evaluate-laya-speculation.ts --input /absolute/path/to/evaluation-input.json --output /tmp/laya-live-new.json --live
```

- TDD: 클라이언트 27건 실패 확인→27건 통과, 평가 11건 실패 확인→11건 통과, CLI 3건 실패 확인→4건 통과(기존 파일 보존 테스트 1건은 초기부터 통과).
- 새 테스트 합계 42개, 전체 단위 테스트 139파일/1,108개 통과. 타입 검사와 대상 파일 린트 통과.
- 전체 로컬 `npm run lint`는 기존 비추적 작업트리/빌드 산출물/실험 파일까지 읽어 실패했다. Git에 포함된 소스 603개만 동일 ESLint로 검사한 결과 오류 0개(기존 vendor 경고 1개)였다. 해당 외부 작업 파일은 수정하지 않았다.
- CLI의 실제 HTTP 계약은 로컬 모의 서버로 확인했다. 사용자 LAYA 서버에 인증 호출한 결과와 구분한다.
- 이전 공개 프로젝트 표본 47개로 [dry-run 보고서](../../operations/evaluations/2026-09-21-laya-speculation/dry-run.json) 생성 완료. 설치형/500별 이상 14개이며 API 호출은 없었다. 기존 timing은 모델 순수 시간이 아니므로 모두 null로 전달했다.
- 2026-09-21 사용자 클립보드 키로 실제 LAYA 14건 모두 정상 응답, 중앙값 22.7ms/p95 102.7ms. 선행 계산 제안 5건은 모두 기존 1차 승인에 해당. 재사용 표본이므로 사람 정답 정확도나 일반화 성능은 아니다. [실측 보고서](../../operations/2026-09-21-laya-speculation-live-check.md).
- 새 저장소 100개 실제 호출 완료: 응답 100/오류 0, 중앙값 20.3ms/p95 33.6ms, 제안 54개 중 기존 승인 46/거절 8. 질문/0.9 기준 고정, 기존 47개와 중복 0 확인. 키는 저장하지 않았다. 전체 승인 비중 81% 대비 선택군 85.2%; 사람 정답 정확도는 아니다. 읽기 전용 대기열 조회는 완료했으나 공유 서버 여유 용량/실측 절감/PR-02 진입 조건 충족은 확인되지 않았다. DB 쓰기/운영 설정/배포/화면 변경 없음.
- 커밋 `9bc53de` GitHub CI(타입·린트·단위·통합·빌드)와 GitGuardian 성공 확인.
