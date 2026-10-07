# 검색 모델 서버 (2026-10-07)

의미 검색은 두 모델을 쓴다. 둘 다 서버 Mac(M3)에서 llama.cpp `llama-server`로 돈다.

| 이름 | 모델 | 포트 | 쓰는 곳 | 환경변수 |
|---|---|---|---|---|
| `bot.brut.nmv-embed` | bge-m3 F16 GGUF (sha256 `daec91ff…`, Ollama `bge-m3`과 같은 파일) | 18081 | text 워커(`product-embedding`)·웹(검색어) | `EMBEDDING_URL=http://192.168.50.241:18081` |
| `bot.brut.nmv-rerank` | bge-reranker-v2-m3 F16 GGUF (gpustack, sha256 `5df93be1…`) | 18082 | 웹(상위 30 재정렬) | `RERANK_URL=http://192.168.50.241:18082` |

- 설치·재설치: 서버 Mac 에서 `scripts/ops/search-models.sh install`. 실행 파일(llama.cpp b11429)과 모델을 해시로 확인하고
  사용자 launchd 에이전트로 등록한다(KeepAlive, 죽으면 5초 안에 다시 뜬다). 상태: `search-models.sh status`.
- 위치: `~/nmv-search/{bin,models}`, 로그 `~/Library/Logs/nmv-embed.log`·`nmv-rerank.log`.
- 메모리: 임베딩 약 2.0GB, 재정렬 약 2.4GB(M3 실측).
- 서버가 없거나 늦으면 검색은 낱말 검색만으로 결과를 낸다. 잡은 다음 틱에 다시 본다.
- 모델 파일을 바꾸면 `lib/domain/products/embedding.ts`의 `EMBEDDING_MODEL`도 바꾼다 — 잡이 전부 다시 임베딩한다.
  제품 벡터와 검색어 벡터가 다른 모델이면 순위가 조용히 틀어진다.

## 왜 이 구성인가

정답 60 질의(scripts/search-judged.ts, 방식을 가린 채 채점을 보탬)로 잰 nDCG@10:
낱말 검색 0.725 → 낱말 + 의미(RRF k=60, 각 200위) 0.793 → 상위 30 재정렬 **0.832**. 번역을 기다리지 않아도 0.824.

- 임베딩할 글은 이름·소개·설명·토픽·카테고리·키워드. 본문·README 를 넣으면 나빠졌고, 키워드를 빼면 재정렬이 크게 나빠졌다.
- 의미 검색만으로 걸린 결과는 코사인 0.5 이상만 넣는다 — 품질은 같고("asdfgh" 같은 말에 결과가 붙지 않는다) 질의당 덧붙는 수가 163→68건.
- 실행기(M5 Max 실측): llama.cpp 임베딩 5.4ms·1.8GB, 재정렬 30쌍 288ms·2.2GB, 정확도는 기준과 같다.
  MLX 는 이 두 모델을 공식 지원하지 않는다(임베딩 라이브러리 기본이 평균 풀링이라 bge-m3 에 틀린 벡터, 재정렬 없음, 메모리가 불어남).
  TEI 는 Metal 에서 10배 느리다. Ollama 는 같은 엔진이지만 자동 업데이트·모델 내림·재정렬 API 없음 때문에 따로 둔다.

## DB

`product_embeddings`(0059, halfvec(1024)). pgvector 는 슈퍼유저가 만든다 — 프로드는 2026-10-07 V9-Primary 에서
`CREATE EXTENSION vector`(0.8.6). 웹 검색 읽기는 복제본(V9-Replica)으로 가므로 복제본에도 같은 패키지
(`postgresql-17-pgvector` 0.8.6-1.pgdg24.04+1)가 있어야 한다. 테스트·로컬 DB 는 `pgvector/pgvector:0.8.6-pg17`.
