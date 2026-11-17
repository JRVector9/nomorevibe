# 일본어 번역 요청이 중국어로 오는 문제 — PR #985

- PR: https://github.com/JRVector9/nomorevibe/pull/985
- 브랜치: `fix/translation-ja-language-20261117`. 시작 base는 `a9c53498`이다.
- 범위: 문제 1(ja 혼동)만 다룬다. 문제 2(english_uncertain 오판)는 다른 PR이 맡는다. 그래서 이 PR은 `lib/domain/products/translation-policy.ts`와 `lib/i18n/content-language.ts`를 고치지 않는다.
- 금지: 병합, 배포, 운영 설정 변경, 운영 DB 쓰기.

## 남은 일

- [x] Draft PR을 열었다. 원인은 코드와 기존 실측 재판정으로 확인했다.
- [x] 수정: 한 묶음에는 한 언어만 담는다. 잡은 후보를 16건까지 읽는다.
- [x] 재현·회귀 시험 `tests/product-translation-ja-batch.test.ts`. 수정 전 코드에서는 2건이 실패한다.
- [x] M1Max 수정 후 실측(같은 200개 항목을 새 묶음으로 구성)
- [x] 운영 장부 errorCode 읽기(읽기 전용)
- [x] tsc, eslint, 관련 vitest, deploy scope
- [x] PR CI check 통과 확인(run 44061544751, head 0883d931: check·unit 2·integration 6·integration-ledger·lint·typecheck·build 모두 통과)
- 막힌 것: 없음.
- 범위 밖이라 남긴 것:
  - 문제 2(english_uncertain)
  - 운영 배포 뒤 ja 실제 성공률 관측. ja 52,725건은 아직 한 번도 요청되지 않았다.

## 원인

`lib/jobs/products/translations.ts`는 수요 순서대로 앞의 4건을 그대로 묶었다. 수요 순서는 `updated_at`, 제품, 언어, 칸 순이다.

- 그래서 같은 제품의 en·ja·zh-Hans, 또는 앞 제품의 zh-Hans 뒤에 오는 ja가 한 요청에 섞였다.
- ja 지시는 시스템 문장 끝의 한 줄뿐이다. Qwen 계약 문구와 첫 문장은 en·zh-Hans·zh-Hant만 말한다.

수정 전 M1Max 실측(운영 wire 그대로 50묶음, main `a9c53498`):

| ja 위치 | 건수 | not_japanese |
| --- | --- | --- |
| zh-Hans 뒤에 처음 나온 ja | 34 | 18 |
| 묶음 맨 앞 ja | 16 | 0 |
| 앞에 ja가 이미 있는 ja | 16 | 0 |

not_japanese 18건 가운데 16건은 같은 묶음 zh-Hans 항목의 언어를 이어 쓴 중국어 간체였다.

## 고친 방법과 이유

`lib/jobs/products/translation-locale-batch.ts`: 잡은 대기 중인 번역 후보를 16건까지 읽는다. 그중 맨 앞(가장 오래 기다린) 건과 같은 언어만 남긴 뒤, 기존 `packProductTranslationBatch`로 4건과 8,000자 제한에 맞춰 묶는다.

- 맨 앞 건은 늘 들어간다. 그래서 어떤 언어도 계속 밀려나지 않는다.
- 남은 다른 언어 건은 넘김으로 기록하지 않는다. 다른 lane이나 다음 틱이 다시 고른다.
- `pendingProductTranslations`의 읽기 상한은 8 → 16으로 올렸다.
- 시스템 문장과 wire 바이트는 바꾸지 않았다. 그래서 M1Max 프롬프트 캐시의 공통 앞부분이 그대로 유지된다. ja 지시는 예전처럼 ja가 든 묶음 끝에만 붙는다.
- 묶음은 모델을 고르기 전에 정해진다. 그래서 순위의 모든 경로가 같은 단일 언어 묶음을 받는다. 운영 순위는 1순위 gpt-oss-120b(M3), 2순위 Qwen3.8-27B-4bit(M1max)다.
- 다른 방법을 고르지 않은 이유:
  - 항목별 언어 지시 강화는 user JSON 형식을 바꾼다. 그러면 모든 모델의 출력이 달라질 수 있다.
  - 실패 항목만 다시 요청하는 방식은 기존 attempts·retry_at으로 이미 된다. 다시 요청해도 섞인 묶음에 들어가면 같은 실패가 되풀이된다.

### 호출 수 영향(운영 대기열 모의, 읽기 전용, 2026-11-17)

모의 대상은 대기 155,429건이다(en 47,253, zh-Hans 55,448, ja 52,728). 운영 정렬 그대로 모의했다.

| 묶음 방식 | 호출 수 | 섞인 묶음 | ja+zh-Hans 묶음 |
| --- | --- | --- | --- |
| 예전(앞 4건) | 38,858 | 19,365 | 5,758 |
| 창 8, 같은 언어 | 43,662 (+12.4%) | 0 | 0 |
| 창 16, 같은 언어(채택) | 40,800 (+5.0%) | 0 | 0 |

## M1Max 실측 (Qwen3.8-27B-4bit, 운영 판정 parseKoreanTaglines·checkProductTranslation)

| | 묶음 | 전체 | en | zh-Hans | ja | not_japanese | 묶음 형식 실패 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 수정 전(main a9c53498, 50묶음) | 50 | 148/200 | 43/67 | 62/67 | 43/66 | 18 | 1 |
| 수정 후(창 8로 다시 묶음) | 51 | 171/200 | 46/67 | 65/67 | 60/66 | 0 | 0 |
| 수정 후(창 16, 최종 코드) | 51 | 172/200 | 47/67 | 65/67 | 60/66 | 0 | 0 |

- **수정 전**: 요청 50개는 gpu3090 `/tmp/xaegis/m1apc/cases3.json`이고, 응답은 `before3.jsonl`(2026-11-17 09:23~09:34Z)이다.
  - 현재 코드로 만든 wire가 50/50 바이트 단위로 같음을 확인하고 다시 판정했다.
  - 대표 측정과 같은 판정이다. 다만 묶음 형식 실패는 이 판정으로 1/50이다.
- **수정 후**: 같은 200개 항목을 같은 순서의 수요 대기열로 보고, 잡과 같은 규칙으로 다시 묶었다. 섞인 묶음은 0이다.
  - 창 8 기준 51회를 호출했다.
  - 창 16은 34묶음의 wire가 창 8과 같다. 같은 wire의 응답을 다시 쓰고, 달라진 17묶음만 추가로 호출했다.
  - M1Max 호출은 모두 68회다.
- **english_uncertain(문제 2, 별도 PR)**: 수정 전 23 → 창 8 21 → 창 16 20.
- **남은 ja 실패 6건은 모두 `number_changed`다.**
  - 4건은 원문 "하나의 패널"·"한곳에"를 "1つ"·"1か所"로 옮긴 것이다. 예전에는 같은 원문이 not_japanese로 먼저 걸렸다. 이제는 일본어로 나오지만 숫자 검사에 걸린다.
  - 2건은 "0〜100"이 든 영어 원문(Tremor)이다. 수정 전에도 같은 원문 2건이 number_changed였다.
  - 숫자 검사는 `translation-policy.ts`의 몫이라 이 PR 범위 밖이다.
- 측정 스크립트는 `regroup.ts`, `check.ts`, `summ.py`다. 보고함 첨부에 있다. 키 값은 어디에도 저장하지 않았다.

## 운영 장부 (읽기 전용, 2026-11-17 09:4xZ, `begin read only`)

- ja: 52,725건 모두 `pending`, attempts 0이다. 한 번도 요청되지 않아 운영의 `rejected:not_japanese`는 0건이다.
  - 대기열 정렬상 ja 앞에 en·zh-Hans 50,342건이 있다.
  - 같은 제품·칸에 ja와 zh-Hans가 함께 대기 중인 것은 32,226건이다.
- 최근 7일 시도분(attempts>0):

  | 언어 | 전체 | ready | rejected:english_uncertain |
  | --- | --- | --- | --- |
  | en | 35,486 | 9,478 | 19,776 (55.7%) |
  | zh-Hans | 52,253 | 43,731 | 0 |

## 검증

- `npx vitest run`(관련 11개 파일): 166 통과. 새 시험 `tests/product-translation-ja-batch.test.ts`는 5개다. 수정 전 코드에서는 이 가운데 잡 시험 2개가 실패한다.
- `npx tsc --noEmit`(next typegen 뒤): 통과.
- eslint(바뀐 파일): 통과.
- `npm run deploy -- scope --base a9c53498… --sha <head>`: mode `full`, 18개 앱 전부. 사유는 `unclassified_runtime_change`(lib 변경)다. 실제 실행 경로는 text 역할의 product-translate 잡이다.
