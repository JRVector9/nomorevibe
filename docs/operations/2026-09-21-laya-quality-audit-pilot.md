# LAYA 관리자 품질 점검 실험

상태: **평가 도구 구현·실제 20건 호출·검토 화면 준비 완료. 사람 검토와 효과 판정 대기.** 운영 심사/발행 경로 연결 없음. 구현 커밋 `f56046b`, [PR #160](https://github.com/JRVector9/nomorevibe/pull/160)은 #159 위에 쌓은 초안이다.

## 목적과 범위

사용자는 LAYA를 서비스에 도움이 되는 좁은 용도부터 진행하도록 요청했다. 발행된 제품에서 문서·강좌·자료 목록이 섞였는지 관리자가 확인하는 데 도움을 주는지를 시험한다. 자동 승인·거절·삭제·재심사, 운영 큐 순서 변경은 없다. 실제 앱의 기존 `product_audit_*` 감사 캠페인과 별개이며 해당 테이블에도 쓰지 않는다.

첫 범위는 현재 공개 상태(`seeded`, `verified`)의 설치형 제품·500별 이상이다. 최근 7일의 현재 1차 모델/프롬프트로 새로 실행한 성공 기록이 있어야 하며, 이전 LAYA 평가에 사용한 147개 저장소는 제외했다. 이 조건을 만족한 모집단은 **20개**였고 전부 평가했다. 전 서비스에 대한 무작위 표본은 아니다. 수집된 심사 원문 시점과 현재 저장소가 달라질 수 있으므로 검토 화면에서 차이를 기록하도록 안내한다.

## 실측과 비교 설계

[측정 결과](evaluations/2026-09-21-laya-quality-pilot/measurement.json): 실제 API 응답 20/20, 오류 0, 중앙값 **22.0ms**, p95 **84.4ms**. 기존 질문 `installable-software-2026-09-21.1`을 그대로 사용했다. API 응답 속도가 실제 검토 시간 절감이라는 뜻은 아니다.

- 제품일 확률이 낮은 순으로 점검 제안 5개를 뽑는다. 낮은 점수는 확인 순서만 정하는 실험용 신호이며, 제품이 아니라는 판정이 아니다. 승인용 0.9 기준을 뒤집어 새로운 거절 기준으로 쓰지 않는다.
- 동일한 전체 모집단에서 모델 점수와 무관하게 해시 seed로 무작위 대조 5개를 뽑는다. 제안군을 뺀 나머지만 대조군으로 삼지 않는다.
- 두 그룹에 동시에 뽑힌 1개는 한 번만 검토한다. **화면은 9개**이며 그룹 구분·확률·기존 1차 판정을 숨기고 순서를 섞었다. 모델 호출이 실패한 항목을 빼고 비교하지 않도록 전체 응답이 유효해야 화면을 만들 수 있다.
- 사람은 제품 유지/제품이 아닌 것으로 보임/추가 확인 필요를 선택한다. 제외 의심에는 원문 근거가 필요하다. 시간은 외부 자료 확인을 포함한 초 단위 자가 기록이며, 모르면 빈칸으로 둔다.
- 전체 항목을 검토하기 전에는 두 그룹의 효과 차이를 확정하지 않는다. `추가 확인 필요`를 분모에서 빼서 발견률을 부풀리지 않는다. 시간이 빠졌거나 발견 항목이 0개라면 건당 시간은 null이다.
- 그룹 간 중복을 공개하며 통계적 유의성은 계산하지 않는다. 입력한 판단은 검토자 제공 데이터이지 코드가 검증한 정답은 아니다. 작은 표본이므로 검토가 끝나도 전면 적용 근거로 삼지 않는다.

## 화면과 사용법

로컬 화면: http://127.0.0.1:8896/

정적 파일: `.crawl-samples/laya-quality-pilot/review-final/index.html`. 모델 점수와 그룹 배정은 화면 HTML/JSON에 포함하지 않는다. 원문은 실행되지 않는 텍스트로 표시하며 CSP로 외부 통신을 막는다. 원본 GitHub 링크는 새 탭으로 열린다. 입력은 해당 브라우저에 저장되며 `검토 결과 내려받기`로 JSON을 저장한다. 내려받는 동작은 운영 데이터에 영향을 주지 않는다.

실제 검토 답변은 아직 0개다. 기존 `product_audit_items`의 사람 판정도 읽기 전용으로 조회했으며, 이번 20개 제품에 대응하는 기록은 0개였다. 이전 모델 승인을 사람의 정답으로 채우지 않았다. 브라우저 테스트에서 입력한 가상 판단은 격리된 테스트 컨텍스트에만 있었으며 실제 평가 파일이나 운영 DB에 저장되지 않았다.

구현 파일:

- `lib/crawl/laya-quality-audit.ts`: 입력·응답 해시 대조, 점검군/대조군 배정, 가린 HTML, 검토자 응답 검증과 비교 집계.
- `scripts/prepare-laya-quality-audit.ts`: 저장된 원문/응답만 읽는 오프라인 CLI. 2MiB 파일 제한, 기존 출력 디렉터리 덮어쓰기 금지, 0600 결과 파일, 원문·예외를 콘솔에 출력하지 않음.
- 기존 `laya-preview`/`evaluate-laya-speculation`은 API 통신에 재사용했다. 그 결과의 `suggestedPrefetch`는 이번 품질 점검 비교에 사용하지 않는다.

```sh
# 기존 20건 원문/응답으로 화면을 다시 생성. 출력 디렉터리는 새 경로여야 한다.
node --import tsx scripts/prepare-laya-quality-audit.ts \
  --input .crawl-samples/laya-quality-pilot/input.json \
  --responses .crawl-samples/laya-quality-pilot/laya-responses.json \
  --out-dir /tmp/nmv-quality-review-new \
  --seed quality-audit-20260921-v1 --take 5

# 사람이 화면에서 내려받은 결과 집계. 새 출력 경로 사용.
node --import tsx scripts/prepare-laya-quality-audit.ts \
  --input .crawl-samples/laya-quality-pilot/input.json \
  --responses .crawl-samples/laya-quality-pilot/laya-responses.json \
  --out-dir /tmp/nmv-quality-reviewed-new \
  --seed quality-audit-20260921-v1 --take 5 \
  --annotations /absolute/path/to/downloaded-review.json
```

## 비밀 환경 설정

사용자 명시 요청으로 키를 **`~/.config/nomorevibe/laya.env`**에 저장했다. 파일 권한 0600, Git 저장소 밖이며 키 값은 코드·보고서·명령행 인수에 넣지 않는다. 환경 파일에서 LAYA_URL/LAYA_API_KEY가 로드되는지 확인했다. 앞으로 키를 다시 요청하기 전에 이 파일을 사용한다. 이는 로컬 평가 설정이며 운영 서버 설정은 변경하지 않았다.

```sh
# 새로운 표본 API 평가 시 기존 비밀 환경을 명시적으로 로드한다.
node --env-file="$HOME/.config/nomorevibe/laya.env" --import tsx \
  scripts/evaluate-laya-speculation.ts \
  --input /absolute/path/to/new-samples.json \
  --output /absolute/path/to/new-responses.json --live
```

## 검증과 남은 일

- TDD: 새 모듈 14개 중 6개 실패 확인 후 14개 통과(입력 거절 테스트 8개는 stub에서도 통과). CLI 4개 중 2개 실패 확인 후 4개 통과(출력 보존/실패 경로 2개는 stub에서도 통과).
- LAYA 관련 5파일 **60개 통과**. 전체 단위 **141파일/1,126개 통과**. 타입 검사와 새 4파일 ESLint 통과.
- 실제 정적 화면 브라우저 QA: 원문 펼치기, 잘못된 답변 차단, 새로고침 후 입력 보존, JSON 다운로드, 1440px/390px 화면, 가로 넘침 없음, 콘솔 오류 0, 외부 요청 0. 가상 검토 결과를 사람의 정답으로 사용하지 않았다.
- Python Playwright 모듈이 없어 저장소에 이미 설치된 Node Playwright로 같은 절차를 수행했다. CUA는 연결 가능한 브라우저가 없어 사용자 브라우저 탭은 자동으로 열지 못했다. 위 로컬 링크는 실행 중이다.
- 읽기 전용 표본 추출 첫 시도는 SQL `limit100` 오타로 실패했고 `limit 100`으로 수정한 뒤 성공했다. 운영 쓰기는 없었다.

다음은 사람이 9개를 검토한 결과를 받아 두 그룹의 발견률과 자가 기록 시간을 비교하는 단계다. 무작위 점검보다 도움이 되는지 확인되기 전에는 운영 관리자 메뉴에 상시 기능으로 배포하지 않는다. 앞서 제안한 2차 심사 선행 계산 PR-02/03도 계속 보류 상태다.
