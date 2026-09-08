# Publisher 카테고리 분류 운영 기록

## 적용 결과

제품 카테고리는 기존 값을 깨뜨리지 않고 17개로 확장했다.

```text
Productivity, Dev, Design, Business, Marketing, Finance, Commerce,
Education, Health, Media, Games, Social, Data, Security, Lifestyle,
Sports, Other
```

publisher는 발행 가능한 후보만 준비한 뒤 최대 10개를 한 번에 분류한다. 1차는
`gpt-5.3-codex-spark`·effort xhigh·8초, 2차는 `gpt-5.6-terra`·effort high·12초다. 두 호출이
실패하거나 출력이 유효하지 않으면 키워드 규칙으로 발행을 계속한다. AI 리뷰 워커는 이 변경과
분리된 Claude 경로를 그대로 사용한다.

두 모델 timeout만으로 일반 25초 잡 예산 대부분을 쓸 수 있으므로 publisher의 협력 예산은 120초,
supervisor hard timeout은 180초로 둔다. timeout batch가 후보 한 건만 처리하고 다음 5분 주기에 같은
나머지를 다시 분류하는 반복을 피하기 위한 값이다.

모델 호출 전의 원본 문서·설정·agent evidence를 snapshot으로 보존한다. 호출 뒤 발행 트랜잭션이
현재 행을 잠그고 snapshot과 비교하므로 분류 중 관리자 판정이나 수집 원문이 바뀐 후보는 발행하지
않는다. 출력 순서에 의존하지 않고 입력 숫자 ID 전체가 중복·누락 없이 돌아온 경우만 채택한다.

## CLI 격리와 인증

Codex는 `--strict-config`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, read-only sandbox를
사용하고 plugin·shell·web을 끈다. 제품 문자열은 신뢰하지 않는 JSON 데이터로 감싸며 `<`와 `>`를
이스케이프한다. worker 이미지에는 Codex CLI `0.153.4`와 Claude Code CLI `2.1.263`을 고정했다.

publisher 시작 시 `scripts/codex-auth.sh`가 다음 우선순위로 로그인한다.

1. `CODEX_ACCESS_TOKEN`이 있으면 `codex login --with-access-token`
2. access token이 없거나 로그인이 실패하고 `OPENAI_API_KEY`가 있으면 `codex login --with-api-key`
3. 로그인 뒤 원문 비밀값을 환경에서 제거하고 publisher 실행

로그인 실패로 worker 자체를 종료하지 않는다. 모델 호출이 실패하면 다음 모델 또는 키워드 규칙으로
진행한다. Spark는 Codex 연구 프리뷰라 운영 계정에서 access token 사용이 가능한지 배포 전에 확인해야
한다. Terra는 API key 경로의 운영 폴백이다.

## 2026-09-08 비교 결과

개발 DB에서 기존 `Other` 22건을 뽑아 같은 입력과 17개 분류표로 비교했다.

| 표본 | Spark xhigh | Terra xhigh |
|---|---:|---:|
| 일반 10건 | 5.119초 · 8,775 tokens | 10.463초 · 10,410 tokens |
| 게임 후보 12건 | 5.276초 · 3,731 tokens | 12.983초 · 10,725 tokens |
| 전체 일치 | 21/22 (95.5%) | 21/22 (95.5%) |

유일한 불일치는 Craft Football을 Spark가 Social, Terra가 Lifestyle로 본 경우다. 실제 구현 경로를
사용한 smoke에서는 wedding 표본이 Lifestyle, playable puzzle 표본이 Games로 분류됐다. 속도와
일치율을 근거로 Spark xhigh를 1차에 두고, 비용·가용성을 고려해 Terra 폴백은 high로 낮췄다.

## 운영 확인 항목

- 이미지 안에서 `codex --version`, `claude --version`을 확인한다.
- publisher 로그에서 Spark 성공, Terra 전환, 키워드 폴백을 구분한다.
- 10개 이하 batch 응답 시간과 timeout 비율, 카테고리 분포를 기록한다.
- reviewer에는 Codex 비밀값을, publisher에는 Claude 비밀값을 주입하지 않는다.
- 운영 자격 정보와 실제 GitHub 수집을 켠 24시간 관측 전에는 상시 운영 완료로 판정하지 않는다.
