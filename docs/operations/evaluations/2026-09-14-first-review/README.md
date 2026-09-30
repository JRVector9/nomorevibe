# 1차 모델 비교 원자료 — 2026-09-14

상위 보고서: [평가 보고서](../../2026-09-14-first-review-abcllm-evaluation.md).

- `cases.csv`: 공개 저장소 50건의 모델별 판정·confidence·지연 비교.
- `results.jsonl`: 실제 200회 응답의 검증 결과/사용량/요청 및 응답 모델 ID. 실패도 포함, 재시도 제외.
- `summary.json`: 관리자 판정 일치율, Wilson 구간, 지연, 실제 combineVotes 기반 가상 합의 결과.
- `manifest.json`: 동결 데이터/프롬프트 해시, 버전, 호출 제한. 시작 시각은 UTC.
- `compatibility.json`: 모델명/중복 투표/신뢰도/대기 규칙 10개 검사 결과.
- `policy-gaps.json`: README 링크 정보 손실과 낮은 확신의 반대 의견/보류 제외 합의 재현 4개.
- `input-audit.json`: 최근 운영 2차 90행의 입력 30건 해시 비교. 읽기 전용, 현재 일치가 과거 호출 입력의 일치를 증명하지는 않는다.

모든 표본이 GitHub Pages이고 승인 25건에만 저장 페이지 본문이 있다. 과거 관리자 라벨은 현재 정책의 정답을 보장하지 않는다. 일치율을 서비스 전체 정확도로 부르지 않는다. 운영 판정이나 설정은 수정하지 않았다.

동결 입력과 재실행 스크립트는 로컬 `.crawl-samples/abcllm-first-review-20260914/`에 남겼다. 집계 재실행은 저장소 루트에서 `npx tsx .crawl-samples/abcllm-first-review-20260914/analyze.ts`이며 추가 모델 호출이나 DB 변경이 없다. 모델 호출 자체를 재개할 때는 기존 권한으로 제공자 자격 증명을 환경에 설정하고 `evaluate.ts`를 실행한다. 완료 키가 있으면 해당 호출은 생략한다. 자격 증명은 이 자료에 저장하지 않는다.
