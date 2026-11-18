# 2026-11-18 README 임베딩 오프라인 실험

[Draft PR #992](https://github.com/JRVector9/nomorevibe/pull/992) · 공개 제품 스냅숏 기준 커밋 `ebd63092`

## 결론

**V0 유지 권고.** 블라인드 채점을 합친 재정렬 후 nDCG@10은 V0에서 캐시 사용 0.7959, 미사용 0.7805였다. 다른 안의 점수 차이는 두 조건에서 모두 ±0.007 이내였고, 대응 질의 부트스트랩 95% 구간이 모두 0을 포함했다.

- V2 중에서는 **0.5**가 재정렬 후 두 번역 조건에서 가장 높았다. 캐시 사용은 0.7973로 V0 대비 +0.0014 [−0.0039, +0.0064]였고 개선 10개·하락 7개였다. 미사용은 0.7866으로 +0.0061 [−0.0058, +0.0170]였고 개선 16개·하락 11개였다.
- V2 가중치 1.0은 RRF 단계에서 캐시 사용 −0.0503 [−0.0730, −0.0278], 미사용 −0.0349 [−0.0547, −0.0160]이었다. 0.3은 두 조건의 RRF 단계에서 0.5보다 V0에 가까웠다.
- V1·V1raw는 캐시 사용에서 재정렬 후 약 +0.002, 미사용에서 약 −0.007이었다. 재정렬 전 미사용에서는 각각 −0.020·−0.021이었다. 이번 V1raw는 10월과 달리 페이지 본문을 포함하지 않았다.
- 기존 채점만 쓰면 재정렬 후 V2@1.0이 V0보다 +0.0204(캐시 사용)·+0.0371(미사용) 앞섰다. 같은 순위를 보강 채점으로 다시 내자 −0.0039·+0.0043으로 바뀌었다. 최초 상위 10 미채점은 조건별 310~432건이었고, 932쌍을 채점한 뒤 모든 조건에서 0건이었다.

V2@0.5는 V0에 벡터 데이터 72.9MiB와 로컬 PostgreSQL 기준 101.7MiB를 더한다. 실측 처리량으로 환산한 추가 임베딩은 0.63시간, V0을 포함한 전체 재생성은 1.43시간이다. 캐시 사용에서 재정렬 후 질의 시간 p50/p95는 V0 942/2,278ms, V2@0.5 946/2,291ms였다. 의미 목록 조회 p50은 캐시 사용에서 344→358ms, 미사용에서 337→345ms였다. 질의별 입력과 로컬 DB 상태에 따른 변동을 포함한 수치다.

## 판단 기준

같은 질의의 재정렬 후 nDCG@10을 주 지표로 삼고 번역 캐시 사용·미사용 조건을 모두 본다. V2 가중치는 0.3·0.5·1.0을 비교한다. 재정렬 후 캐시 사용 조건의 개선 폭, 다른 조건의 하락 여부, 질의당 비용 순으로 검토한다. 결과 차이가 사실상 같은 경우 가중치가 작은 안을 고른다. 60개 질의에서 여러 가중치를 비교하므로 ±0.02 안팎의 차이는 잡음일 수 있다.

## 코퍼스와 검색 방법

대표가 11월 18일 내보낸 `seeded` 및 `verified` 제품 100,476건과 영어 번역 캐시 249건을 전용 PostgreSQL 17.11·pgvector 0.8.6에 적재했다. 저장소 마이그레이션 185개를 적용했다. PostgreSQL이 기존 방식으로 생성한 `search_vector`와 GIN 인덱스를 사용했다. 제품 37,339건에 공백이 아닌 README가 있었고 30,842건은 2,000자 이상이었다. 정리한 텍스트가 남은 제품은 37,324건이었다. 중간에 잘린 README는 내보낸 범위 안에서 처리했다. 실제 검색 대상은 88,310건이었다. 미클레임 수집 프로필 12,116건, 그 외 감사 보류 44건, 저장소 소실이 확인된 비웹 제품 6건이 제외됐다.

`sha256sum products_*.json text_translations_en.json` 출력의 SHA-256은 `5a30d08b50db12b7843f29a18e0528562f6fc3070c8ffe7431b36848ad8a75e9`이다.

| 안 | 임베딩 문서 | 검색 결합 |
| --- | --- | --- |
| V0 | 저장소의 `EMBEDDING_DOCUMENT` SQL 그대로 | 낱말과 V0 의미 |
| V1 | V0와 정리 README 앞 800자 | 낱말과 V1 의미 |
| V1raw | V0와 원문 README 앞 800자 | 낱말과 V1raw 의미 |
| V2 | V0 벡터 유지, 정리 README 앞 1,000자는 별도 임베딩 | 낱말과 V0 의미에 README 의미 목록 추가 |

V1과 V1raw에서 추가할 글이 없으면 V0 벡터를 재사용했다. V2는 정리 후 글이 남은 제품만 별도 목록에 넣었다. 정리 과정에서 배지·이미지·HTML 마크업·코드 블록·설치 명령·URL·목차를 휴리스틱으로 걷어냈다. 원문 비교 V1raw는 10월 실험의 원문 이어 붙이기 방향을 재현한다. 당시 함께 넣었던 페이지 본문은 이번 비교에 포함하지 않았다.

모든 안에서 기존 낱말 색인의 README 앞 2,000자 가중치 D와, README를 읽어 생성할 수 있는 기존 검색 키워드는 그대로 사용했다. 따라서 측정 대상은 README 텍스트를 벡터 입력에 추가하는 효과다.

낱말 목록과 의미 목록은 각각 앞 200개를 가져왔다. 의미 목록은 현재 운영 검색과 같이 `halfvec(1024)` 코사인 거리를 전수 비교하고 유사도 0.5 이상을 취했다. RRF는 `k=60`이며 낱말과 V0 또는 V1 의미 목록은 가중치 1이다. V2는 README 목록에만 0.3·0.5·1.0을 적용했다. 결과 수는 각 목록과 낱말 검색 전체의 합집합으로 계산했다. 재정렬은 모든 안에서 원문 질의와 기존 `EMBEDDING_DOCUMENT`를 읽고, RRF 상위 30개만 순서를 바꿨다.

번역 사용 조건은 현재 키와 버전이 맞는 이전 키를 로컬 캐시에서 확인한다. `9e95dc37`에서 키 형식이 바뀌었으며, 제공된 한국어 평가 질의 26개는 현재 키 0개, 같은 프롬프트·용어표의 이전 키 26개였다. 실험에서 호환 키 읽기를 택해 제공된 번역으로 비교했다. `--no-translation`은 기존 `search-judged.ts`와 같이 원문 낱말 배열을 쓰므로 두 조건 간 차이에는 번역과 낱말 완화 검색 효과가 함께 들어 있다. 캐시 미스에서 번역을 생성하거나 캐시에 쓰지 않았다.

## 임베딩 검증과 요청 제한

지정된 M3 llama-server의 bge-m3 F16과 bge-reranker-v2-m3 F16만 호출했다. 모델 경로와 임베딩 1,024차원을 서버에서 확인했다. 저장소에 기록된 CLS 설정 및 모델 리비전 `bge-m3-f16@daec91ff`를 기준으로 현재 문서 32개를 두 번 요청했다. 최소 코사인은 0.99999695였고 PostgreSQL `halfvec` 왕복과 비교한 값은 0.99999691이었다. 스냅숏에 운영 저장 벡터는 없으며 HTTP 메타데이터는 풀링 종류를 반환하지 않았다. 이 검사는 현재 서버의 반복성과 로컬 저장 형식 일치를 확인한다.

32개 이하를 한 번씩 직렬로 요청했다. 시작 전과 매 50묶음 후 단일 검색어를 보내 300ms를 넘으면 60초 뒤 다시 측정한다. 첫 실행 구간의 요청 간격은 로그에서 최저 약 298.5ms로 추정됐다. 타이머가 시간을 내림할 수 있는 경로를 보강해 단조 시계로 300ms를 확인하도록 바꾸고, 저장된 문서 벡터 2,560개를 재사용해 재개했다.

벡터 생성에 약 2시간 50분, 전체 질의 순위 측정에 약 12분이 걸렸다. 단일 질의 지연 프로브 150회 중 5회가 300ms를 넘었다(최고 465ms). 각 초과 뒤 60초를 쉬고 통과 후 재개했다. 검색어 임베딩은 60회, 실제 재정렬 호출은 655회였다. 결과가 있는 720조건의 나머지 65건은 동일 요청의 캐시로 평가했다. 검색어 임베딩과 재정렬의 단일 요청 최대는 각각 380ms와 1,090ms였다.

## 채점과 통계

`scripts/search-judged.ts`의 질의 60개와 기존 0·1·2 적합도를 사용한다. 상위 10개에 처음 등장한 질의·제품 쌍은 모든 안과 두 번역 조건, 재정렬 전후에서 중복 없이 풀링한다. 순서와 출처를 가린 뒤 이름·소개·설명·README 앞 1,000자를 읽어 채점을 보탠다. 네 Codex 채점자가 서로 겹치지 않는 233쌍씩 읽어 0점 285쌍, 1점 322쌍, 2점 325쌍으로 판정했다. [채점 기준](../../scripts/experiments/readme-embedding-grading.md) · [채점 원본](../../scripts/experiments/data/readme-embedding-20261118-judgments.json) · [ID 대응표](../../scripts/experiments/data/readme-embedding-20261118-pool-key.json)

대표 정답의 1위, 5위 이내, MRR은 기존 스크립트 규칙을 사용한다. MRR은 20위 밖을 0으로 센다. 다중 정답의 nDCG@10, 상위 5개 적합 비율, 결과 0건 비율, 질의 시간 p50/p95와 미채점 상위 10개 건수도 기록한다. 질의별 차이는 같은 번역 조건·단계의 V0에 대응시킨다. 부트스트랩은 질의를 단위로 동일 질의 쌍을 10,000회 복원 추출한 95% 백분위 구간이다. 여러 안을 고른 데 따른 다중 비교 보정은 적용하지 않는다.

## 스냅숏 한계

- 공개 상태 제품 중 감사 보류 등 제품 행에 저장된 공개 목록 제외 플래그를 적용했다. 별도 `product_health`와 가동 상태 관측은 내보내기에 포함되지 않았다. 로컬 마이그레이션 기본 가동 상태 정책을 사용했다.
- 기존 대표 정답 슬러그 7개는 로컬에서 검색 가능한 제품에 없으며, 해당 질의는 12개다. 평가 분모를 60으로 고정해 재현하고 다중 정답 채점으로 현재 제품을 함께 평가한다.
- 추가 채점은 제품 설명을 근거로 한 Codex 판단이다. 사람의 독립 채점과 실제 제품 사용 검증은 수행하지 않았다. 한·영 질의에는 같은 의도가 반복되며, 별도 검증 질의는 두지 않았다.
- 10월의 제품 수와 검색 입력이 달라 당시 점수와 이번 점수의 변화에는 여러 요인이 들어 있다.
- 질의 시간은 로컬 DB와 M3 호출 실측으로 계산했다. 웹 렌더링, 실제 운영 DB와 복제본 상태, 실험용 대기, 번역 모델 요청은 시간에 포함하지 않았다.

## 로컬 검증

- 실험 파일 범위의 TypeScript, ESLint와 Git 공백 검사를 통과했다.
- 검색·임베딩 회귀 테스트 4개 파일에서 33개 테스트를 통과했다. 최초 시도는 공유 의존성에 `aws4fetch`가 없어 한 파일을 불러오지 못했다. 작업용 scratch에 잠금 파일 기준 의존성을 설치하고 같은 4개 파일을 다시 실행했다.
- 로컬 PostgreSQL의 임시 벡터와 합성 모델 응답으로 24조건 × 4질의를 검증했다. V0 순위 일치, 두 캐시 키의 우선순위, V2 후보, 감사 보류 제외, 0건에서 재정렬 생략을 확인했다. 같은 하네스로 실제 스냅숏의 60개 질의 번역 캐시 적중을 별도로 확인했다.
- 합성 순위는 채점 출처 가리기, 누락 채점 거절, 공통 채점 적용, 부트스트랩 재현성, 비용 환산을 검증하는 데 사용했다.
- 실제 순위 파일에서 24조건 × 60질의, 결과가 있는 720건의 재정렬, 완성된 932개 채점과 조건별 상위 10 미채점 0건을 확인했다. 고정 순위와 채점 원본으로 결과 JSON이 바이트 단위로 재현됐다. Draft PR의 전체 CI는 실행하지 않았다.

## 전체 결과표

### 기존 채점

| 안 | 번역 | 단계 | 1위 | 5위 내 | MRR | nDCG@10 | V0 대비 [95% 구간] | 개선/하락/동률 | 상위 5 적합 | 0건 비율 | p50/p95 ms | 미채점/상위 10 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| V0 | cache | rrf | 27/60 | 40/60 | 0.547 | 0.418 | — | — | 31.0% | 0.0% | 571.5/1989.5 | 406/597 |
| V0 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.409 | — | — | 29.0% | 0.0% | 941.8/2278.0 | 414/597 |
| V0 | none | rrf | 26/60 | 36/60 | 0.512 | 0.423 | — | — | 33.0% | 0.0% | 450.4/665.5 | 376/581 |
| V0 | none | reranked | 22/60 | 37/60 | 0.487 | 0.407 | — | — | 28.3% | 0.0% | 786.3/1213.3 | 395/581 |
| V1 | cache | rrf | 20/60 | 35/60 | 0.442 | 0.359 | -0.058 [-0.086, -0.033] | 12/34/14 | 26.7% | 0.0% | 581.0/1986.8 | 432/597 |
| V1 | cache | reranked | 22/60 | 36/60 | 0.477 | 0.389 | -0.020 [-0.037, -0.005] | 8/16/36 | 27.3% | 0.0% | 933.4/2251.0 | 426/597 |
| V1 | none | rrf | 17/60 | 33/60 | 0.404 | 0.362 | -0.061 [-0.087, -0.038] | 13/34/13 | 29.0% | 0.0% | 452.0/668.3 | 411/579 |
| V1 | none | reranked | 22/60 | 35/60 | 0.476 | 0.395 | -0.012 [-0.026, +0.001] | 13/17/30 | 27.7% | 0.0% | 768.8/1105.7 | 406/579 |
| V1raw | cache | rrf | 22/60 | 35/60 | 0.461 | 0.368 | -0.050 [-0.075, -0.026] | 13/34/13 | 26.7% | 0.0% | 586.5/1998.1 | 429/597 |
| V1raw | cache | reranked | 22/60 | 36/60 | 0.477 | 0.392 | -0.017 [-0.031, -0.004] | 8/14/38 | 28.0% | 0.0% | 916.1/2425.7 | 423/597 |
| V1raw | none | rrf | 19/60 | 34/60 | 0.429 | 0.372 | -0.051 [-0.076, -0.029] | 12/33/15 | 29.3% | 0.0% | 447.3/673.9 | 404/579 |
| V1raw | none | reranked | 22/60 | 35/60 | 0.476 | 0.393 | -0.014 [-0.028, -0.001] | 11/17/32 | 27.7% | 0.0% | 784.1/1214.0 | 403/579 |
| V2@0.3 | cache | rrf | 24/60 | 41/60 | 0.531 | 0.470 | +0.052 [+0.030, +0.074] | 37/8/15 | 39.7% | 0.0% | 571.4/1986.6 | 378/597 |
| V2@0.3 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.413 | +0.004 [-0.006, +0.014] | 9/4/47 | 29.3% | 0.0% | 972.0/2272.5 | 406/597 |
| V2@0.3 | none | rrf | 24/60 | 39/60 | 0.512 | 0.458 | +0.035 [+0.013, +0.058] | 34/12/14 | 38.0% | 0.0% | 450.1/666.7 | 350/584 |
| V2@0.3 | none | reranked | 22/60 | 37/60 | 0.487 | 0.418 | +0.011 [+0.003, +0.020] | 15/6/39 | 30.0% | 0.0% | 793.2/1134.1 | 389/584 |
| V2@0.5 | cache | rrf | 22/60 | 42/60 | 0.510 | 0.487 | +0.069 [+0.040, +0.100] | 36/12/12 | 42.0% | 0.0% | 568.8/1998.0 | 357/597 |
| V2@0.5 | cache | reranked | 22/60 | 37/60 | 0.481 | 0.422 | +0.013 [+0.001, +0.027] | 12/4/44 | 29.7% | 0.0% | 945.9/2291.3 | 397/597 |
| V2@0.5 | none | rrf | 25/60 | 41/60 | 0.522 | 0.468 | +0.045 [+0.018, +0.073] | 34/15/11 | 39.0% | 0.0% | 453.8/668.0 | 341/584 |
| V2@0.5 | none | reranked | 22/60 | 37/60 | 0.488 | 0.423 | +0.016 [+0.005, +0.029] | 20/7/33 | 31.3% | 0.0% | 771.5/1088.5 | 385/584 |
| V2@1.0 | cache | rrf | 21/60 | 40/60 | 0.478 | 0.506 | +0.088 [+0.047, +0.130] | 36/13/11 | 48.3% | 0.0% | 565.6/2008.4 | 312/597 |
| V2@1.0 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.430 | +0.020 [+0.003, +0.040] | 18/8/34 | 32.3% | 0.0% | 895.1/2373.0 | 390/597 |
| V2@1.0 | none | rrf | 23/60 | 39/60 | 0.495 | 0.510 | +0.086 [+0.047, +0.128] | 34/16/10 | 43.7% | 0.0% | 453.7/660.4 | 310/584 |
| V2@1.0 | none | reranked | 22/60 | 38/60 | 0.489 | 0.444 | +0.037 [+0.018, +0.059] | 23/5/32 | 34.7% | 0.0% | 806.2/1076.5 | 357/584 |

### 추가 채점 포함

| 안 | 번역 | 단계 | 1위 | 5위 내 | MRR | nDCG@10 | V0 대비 [95% 구간] | 개선/하락/동률 | 상위 5 적합 | 0건 비율 | p50/p95 ms | 미채점/상위 10 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| V0 | cache | rrf | 27/60 | 40/60 | 0.547 | 0.759 | — | — | 85.7% | 0.0% | 571.5/1989.5 | 0/597 |
| V0 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.796 | — | — | 88.7% | 0.0% | 941.8/2278.0 | 0/597 |
| V0 | none | rrf | 26/60 | 36/60 | 0.512 | 0.745 | — | — | 84.0% | 0.0% | 450.4/665.5 | 0/581 |
| V0 | none | reranked | 22/60 | 37/60 | 0.487 | 0.780 | — | — | 86.7% | 0.0% | 786.3/1213.3 | 0/581 |
| V1 | cache | rrf | 20/60 | 35/60 | 0.442 | 0.752 | -0.007 [-0.022, +0.007] | 23/19/18 | 85.0% | 0.0% | 581.0/1986.8 | 0/597 |
| V1 | cache | reranked | 22/60 | 36/60 | 0.477 | 0.798 | +0.002 [-0.007, +0.010] | 12/14/34 | 87.7% | 0.0% | 933.4/2251.0 | 0/597 |
| V1 | none | rrf | 17/60 | 33/60 | 0.404 | 0.725 | -0.020 [-0.037, -0.006] | 18/27/15 | 83.0% | 0.0% | 452.0/668.3 | 0/579 |
| V1 | none | reranked | 22/60 | 35/60 | 0.476 | 0.774 | -0.007 [-0.020, +0.005] | 12/15/33 | 85.3% | 0.0% | 768.8/1105.7 | 0/579 |
| V1raw | cache | rrf | 22/60 | 35/60 | 0.461 | 0.749 | -0.010 [-0.024, +0.004] | 22/24/14 | 84.7% | 0.0% | 586.5/1998.1 | 0/597 |
| V1raw | cache | reranked | 22/60 | 36/60 | 0.477 | 0.798 | +0.002 [-0.006, +0.010] | 12/12/36 | 88.3% | 0.0% | 916.1/2425.7 | 0/597 |
| V1raw | none | rrf | 19/60 | 34/60 | 0.429 | 0.724 | -0.021 [-0.037, -0.007] | 15/29/16 | 83.0% | 0.0% | 447.3/673.9 | 0/579 |
| V1raw | none | reranked | 22/60 | 35/60 | 0.476 | 0.774 | -0.007 [-0.020, +0.005] | 12/15/33 | 85.7% | 0.0% | 784.1/1214.0 | 0/579 |
| V2@0.3 | cache | rrf | 24/60 | 41/60 | 0.531 | 0.757 | -0.002 [-0.014, +0.009] | 17/27/16 | 86.0% | 0.0% | 571.4/1986.6 | 0/597 |
| V2@0.3 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.796 | +0.000 [-0.003, +0.004] | 6/4/50 | 89.0% | 0.0% | 972.0/2272.5 | 0/597 |
| V2@0.3 | none | rrf | 24/60 | 39/60 | 0.512 | 0.738 | -0.008 [-0.019, +0.004] | 20/24/16 | 83.0% | 0.0% | 450.1/666.7 | 0/584 |
| V2@0.3 | none | reranked | 22/60 | 37/60 | 0.487 | 0.785 | +0.005 [-0.003, +0.013] | 13/9/38 | 87.0% | 0.0% | 793.2/1134.1 | 0/584 |
| V2@0.5 | cache | rrf | 22/60 | 42/60 | 0.510 | 0.744 | -0.015 [-0.029, +0.000] | 14/31/15 | 83.7% | 0.0% | 568.8/1998.0 | 0/597 |
| V2@0.5 | cache | reranked | 22/60 | 37/60 | 0.481 | 0.797 | +0.001 [-0.004, +0.006] | 10/7/43 | 89.0% | 0.0% | 945.9/2291.3 | 0/597 |
| V2@0.5 | none | rrf | 25/60 | 41/60 | 0.522 | 0.732 | -0.013 [-0.027, +0.000] | 19/28/13 | 82.3% | 0.0% | 453.8/668.0 | 0/584 |
| V2@0.5 | none | reranked | 22/60 | 37/60 | 0.488 | 0.787 | +0.006 [-0.006, +0.017] | 16/11/33 | 87.0% | 0.0% | 771.5/1088.5 | 0/584 |
| V2@1.0 | cache | rrf | 21/60 | 40/60 | 0.478 | 0.709 | -0.050 [-0.073, -0.028] | 8/43/9 | 80.7% | 0.0% | 565.6/2008.4 | 0/597 |
| V2@1.0 | cache | reranked | 22/60 | 37/60 | 0.480 | 0.792 | -0.004 [-0.017, +0.008] | 14/16/30 | 88.3% | 0.0% | 895.1/2373.0 | 0/597 |
| V2@1.0 | none | rrf | 23/60 | 39/60 | 0.495 | 0.711 | -0.035 [-0.055, -0.016] | 13/40/7 | 80.3% | 0.0% | 453.7/660.4 | 0/584 |
| V2@1.0 | none | reranked | 22/60 | 38/60 | 0.489 | 0.785 | +0.004 [-0.012, +0.019] | 21/12/27 | 88.3% | 0.0% | 806.2/1076.5 | 0/584 |

### 벡터 생성 시간과 저장 공간

실측 요청 시간에 묶음당 300ms를 더한 문서당 시간으로 환산했습니다. DB 적재와 지연 프로브에 따른 대기는 표의 시간에서 제외했습니다. V2의 전체 재생성 시간은 V0을 포함합니다. PostgreSQL 크기는 해당 벡터 테이블의 기본 키와 TOAST를 포함합니다.

| 벡터 | 실제 새 문서 | 묶음 수 | 요청 p50/p95 ms | 전체 재생성 시간 | V0 보유 시 추가 시간 | halfvec 데이터 MiB | PostgreSQL 테이블 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v0 | 100440 | 3139 | 549/1109 | 0.80h | 0.00h | 196.2 | 273.4 |
| v1 | 37324 | 1167 | 1357/2335 | 1.09h | 0.58h | 196.2 | 273.4 |
| v2 | 35937 | 1124 | 1567/2497 | 1.43h | 0.63h | 72.9 | 101.7 |
| v1raw | 36933 | 1155 | 2050/2994 | 1.25h | 0.75h | 196.2 | 273.4 |

### 질의별 nDCG@10 변화

| 안 | 번역 | 단계 | 가장 개선된 질의 | 가장 하락한 질의 |
| --- | --- | --- | --- | --- |
| V1 | cache | rrf | interior design quote comparison (+0.094), multi agent orchestration cli (+0.090), internship certificate management (+0.080) | 약 부작용 확인 (-0.157), 이슬람 기도 카운터 (-0.155), grocery shopping list offline (-0.140) |
| V1 | cache | reranked | 슬랙 봇 만들기 (+0.089), medicine side effects lookup (+0.082), coding agent cost tracking (+0.073) | 드라마 평점 차트 (-0.113), order from local farms (-0.087), internship certificate management (-0.057) |
| V1 | none | rrf | open banking claude mcp (+0.077), 도메인 조회 (+0.067), 식물 병 진단 (+0.057) | 드라마 평점 차트 (-0.337), algorithm study group (-0.135), 유기견 입양 (-0.130) |
| V1 | none | reranked | inspect mcp traffic in vscode (+0.107), 한국 유학 준비 (+0.083), coding agent cost tracking (+0.073) | 드라마 평점 차트 (-0.242), 유기견 입양 (-0.132), 은행 잔액 확인 AI (-0.077) |
| V1raw | cache | rrf | interior design quote comparison (+0.094), internship certificate management (+0.080), 한국 유학 준비 (+0.071) | 약 부작용 확인 (-0.160), 이슬람 기도 카운터 (-0.155), algorithmic copy trading (-0.147) |
| V1raw | cache | reranked | 슬랙 봇 만들기 (+0.089), medicine side effects lookup (+0.082), coding agent cost tracking (+0.073) | 드라마 평점 차트 (-0.113), order from local farms (-0.087), focus app task world (-0.053) |
| V1raw | none | rrf | open banking claude mcp (+0.079), medicine side effects lookup (+0.059), multi agent orchestration cli (+0.057) | 드라마 평점 차트 (-0.337), 유기견 입양 (-0.140), algorithm study group (-0.135) |
| V1raw | none | reranked | post to x from coding agent (+0.140), coding agent cost tracking (+0.073), 일본어 단어장 (+0.057) | 드라마 평점 차트 (-0.242), 유기견 입양 (-0.132), algorithm study group (-0.094) |
| V2@0.3 | cache | rrf | 체스 게임 (+0.168), 은행 잔액 확인 AI (+0.106), focus app task world (+0.079) | algorithmic copy trading (-0.155), 어린이집 관리 (-0.090), adopt a rescued dog (-0.083) |
| V2@0.3 | cache | reranked | chess roguelike (+0.060), 인테리어 견적 (+0.044), medicine side effects lookup (+0.021) | focus app task world (-0.053), inspect mcp traffic in vscode (-0.040), 체스 게임 (-0.018) |
| V2@0.3 | none | rrf | focus app task world (+0.161), 일본어 단어장 (+0.065), lab results pdf (+0.064) | algorithmic copy trading (-0.155), grocery shopping list offline (-0.133), accessible public toilet map (-0.103) |
| V2@0.3 | none | reranked | inspect mcp traffic in vscode (+0.119), 축구 매니저 게임 (+0.076), post to x from coding agent (+0.070) | algorithmic copy trading (-0.107), python sdk image video generation api (-0.068), 숏폼 트렌드 (-0.033) |
| V2@0.5 | cache | rrf | 체스 게임 (+0.206), 은행 잔액 확인 AI (+0.116), focus app task world (+0.095) | algorithmic copy trading (-0.226), grocery shopping list offline (-0.100), python sdk image video generation api (-0.093) |
| V2@0.5 | cache | reranked | 축구 매니저 게임 (+0.076), 인테리어 견적 (+0.044), short form video trends (+0.042) | algorithmic copy trading (-0.086), focus app task world (-0.053), python sdk image video generation api (-0.023) |
| V2@0.5 | none | rrf | focus app task world (+0.156), japanese vocabulary flashcards (+0.091), 일본어 단어장 (+0.067) | algorithmic copy trading (-0.155), grocery shopping list offline (-0.145), internship certificate management (-0.120) |
| V2@0.5 | none | reranked | multi agent orchestration cli (+0.130), inspect mcp traffic in vscode (+0.119), grocery shopping list offline (+0.094) | algorithmic copy trading (-0.211), python sdk image video generation api (-0.065), football club manager game (-0.051) |
| V2@1.0 | cache | rrf | slack bot node (+0.172), 체스 게임 (+0.136), multi agent orchestration cli (+0.099) | algorithmic copy trading (-0.334), grocery shopping list offline (-0.287), short form video trends (-0.242) |
| V2@1.0 | cache | reranked | 축구 매니저 게임 (+0.100), chess roguelike (+0.095), supply chain risk monitoring (+0.095) | algorithmic copy trading (-0.204), 은행 잔액 확인 AI (-0.147), 트위터 자동 게시 (-0.122) |
| V2@1.0 | none | rrf | focus app task world (+0.151), japanese vocabulary flashcards (+0.091), 일본어 단어장 (+0.090) | grocery shopping list offline (-0.281), algorithmic copy trading (-0.229), tech job search (-0.214) |
| V2@1.0 | none | reranked | 은행 잔액 확인 AI (+0.142), post to x from coding agent (+0.104), 체스 게임 (+0.102) | short form video trends (-0.233), algorithmic copy trading (-0.184), python sdk image video generation api (-0.129) |

## 재현 명령

작업 브랜치의 저장소 루트에서 실행한다. 저장소 의존성을 설치한 환경과 제공된 스냅숏이 필요하다. `nmv_exp_root`에는 이 실험의 비공개 scratch 디렉터리를 지정한다. 같은 이름의 기존 컨테이너가 있으면 Docker가 중단하므로 해당 컨테이너의 소유권을 확인한다.

```bash
set -euo pipefail
umask 077
nmv_exp_data=/home/ubuntu/nmv-search-exp-20261118/data
nmv_exp_root=/path/to/private/experiment-scratch
mkdir -p "$nmv_exp_root"

POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD
docker run -d --name nmv-readme-exp-pg -e POSTGRES_USER=nomorevibe \
  -e POSTGRES_PASSWORD -e POSTGRES_DB=nomorevibe_test \
  -p 127.0.0.1::5432 pgvector/pgvector:0.8.6-pg17
nmv_exp_binding="$(docker port nmv-readme-exp-pg 5432/tcp)"
export NMV_README_DB_URL="postgres://nomorevibe:${POSTGRES_PASSWORD}@${nmv_exp_binding}/nomorevibe_test"
unset POSTGRES_PASSWORD
until docker exec nmv-readme-exp-pg pg_isready -U nomorevibe -d nomorevibe_test; do sleep 1; done

MIGRATION_DATABASE_URL="$NMV_README_DB_URL" npm run db:migrate
node --import tsx scripts/experiments/readme-embedding-import.ts "$nmv_exp_data"
node --import tsx scripts/experiments/readme-embedding-vectors.ts --scratch="$nmv_exp_root" --raw
node --import tsx scripts/experiments/readme-embedding-search.ts --scratch="$nmv_exp_root" --out="$nmv_exp_root/rankings.json"
node --import tsx scripts/experiments/readme-embedding-score.ts pool \
  --rankings="$nmv_exp_root/rankings.json" --snapshot="$nmv_exp_data" \
  --out="$nmv_exp_root/blind.json" --key="$nmv_exp_root/blind-key.json"

# 새 비교의 blind.json으로 채점하고 ID·등급을 labels.json에 기록한다.
node --import tsx scripts/experiments/readme-embedding-score.ts score \
  --rankings="$nmv_exp_root/rankings.json" --key="$nmv_exp_root/blind-key.json" \
  --labels="$nmv_exp_root/labels.json" --scratch="$nmv_exp_root" \
  --out="$nmv_exp_root/results.json" --markdown="$nmv_exp_root/results.md"
docker rm -f -v nmv-readme-exp-pg
unset NMV_README_DB_URL
```

이번 실험의 고정 순위 파일 SHA-256은 `1812dd421e12e2aba217d30ea2eb9d08dad7383479768008683a52633e1fda49`이다. 보고함에 첨부된 고정 순위와 ID 대응표, 채점 원본으로 모델을 다시 호출하지 않고 점수를 재집계할 수 있다. 비용 환산을 포함해 재생성하려면 실험 scratch의 `embedding-plan.json`, `embedding-storage.json`, `model-timings.jsonl`을 사용한다.

## 필요할 때 대표가 내보낼 읽기 전용 자료

별도 제품 상태를 이번 결과에 반영하려면 다음 쿼리로 조회 시점의 제외 슬러그만 받는다. 스냅숏과 다른 시점에 조회한 자료에는 그 시점이 필요하다.

```sql
BEGIN READ ONLY;
SELECT p.slug
FROM products p
JOIN product_health h ON h.slug = p.slug
WHERE p.status IN ('verified', 'seeded')
  AND h.failures >= 3
  AND (
    NOT EXISTS (SELECT 1 FROM uptime_control uc WHERE uc.id = 1 AND uc.gate_enabled)
    OR EXISTS (
      SELECT 1
      FROM uptime_gates ug
      JOIN uptime_control uc ON uc.id = 1 AND uc.gate_enabled AND uc.observations_enabled
      JOIN uptime_observations uo ON uo.observation_id = ug.applied_observation_id
      WHERE ug.product_id = p.id AND ug.url = p.url
        AND ug.product_updated_at = p.updated_at
        AND ug.state = 'admitted' AND ug.policy_version = 'regional-v1'
        AND ug.revision = uc.revision AND uo.revision = uc.revision
        AND uo.disposition = 'applied' AND uo.product_id = ug.product_id AND uo.url = ug.url
        AND ug.health_checked_at = h.checked_at AND ug.failures = h.failures AND ug.status = h.status
        AND ug.health_checked_at BETWEEN clock_timestamp() - interval '6 hours' AND clock_timestamp()
    )
  )
ORDER BY p.slug;
ROLLBACK;
```

운영 저장 벡터와 직접 비교하려면 다음 행만 내보낸다. 같은 문서 해시의 재임베딩과 코사인을 비교할 수 있다. 이 조회는 실험에서 실행하지 않았다.

```sql
BEGIN READ ONLY;
WITH documents AS (
  SELECT p.id, left(concat_ws(E'\n',
    nullif(btrim(p.name), ''),
    nullif(btrim(p.tagline), ''),
    nullif(btrim(CASE WHEN p.description = p.tagline THEN '' ELSE p.description END), ''),
    nullif(btrim(coalesce(p.search_topics, '')), ''),
    nullif(btrim(coalesce(p.search_category, '')), ''),
    nullif(btrim(coalesce(p.search_keywords, '')), '')), 2000) AS document
  FROM products p
  WHERE p.status IN ('seeded', 'verified')
  ORDER BY p.id
  LIMIT 256
)
SELECT d.id, e.model, e.text_hash, e.embedding::text
FROM documents d JOIN product_embeddings e ON e.product_id = d.id
WHERE e.model = 'bge-m3-f16@daec91ff' AND e.text_hash = md5(d.document)
ORDER BY d.id
LIMIT 32;
ROLLBACK;
```
