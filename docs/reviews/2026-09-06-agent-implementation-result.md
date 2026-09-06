# 에이전트 근거 수집 구현·검증 결과

2026-09-06 KST. 로컬 `http://localhost:3000`, 개발 DB `localhost:55434/nomorevibe`.

병렬 구현과 독립 코드 리뷰 후 재수집했다. 실제 10개 저장소의 스캔·일반 근거 수집과
10개 상세 페이지의 데스크톱/모바일 검사가 통과했다. 발견한 오류는 수정 후 재검증했다.

## 변경 사항

- 도구, 선언 모델, 모델 제공자, 연결 경로를 분리했다. Grok/Kimi/GLM/DeepSeek/OpenRouter와
  Claude Code/Codex/OpenCode/Aider 등 설정을 버전 있는 카탈로그와 제한된 파서로 검사한다.
- AGENTS.md/CLAUDE.md/SKILL.md는 파일 존재 근거다. 실제 실행·제작 모델 확정으로 표시하지 않는다.
  공유 형식과 예제·하위 프로젝트 범위, auto/fallback/inherit/미확인을 구분한다.
- 공개 여부를 매 재개 시 확인하고 SHA를 고정한다. 토큰·환경변수 전체·프롬프트·대화 로그를
  관측으로 저장하지 않는다. 완료/부분/실패와 이전 정상 관측을 분리한다.
- 기존 32개 제품의 누락된 저장소 링크를 복구했다. 제작자가 숨기거나 삭제한 링크는 보존하며,
  현재 저장소 주소와 선택 당시 주소가 달라지면 백필을 보류한다.
- 오래된 추정 builder를 확정 배지로 보여주지 않고, 실제 API 정보와 파일 출처를 표시한다.
  제작자가 직접 제공한 정보는 별도로 유지한다.
- 자동 발행에는 근거·관계·최신성을 검사한다. 분류 대기 중 거부/원본/설정 변경과 초기 오류
  처리에서도 최신 관리자 결정을 덮지 않도록 트랜잭션 검사를 적용했다.
- 검색 페이지/시간 창/기여 표기 위치를 저장해 예산 중단 후 재개한다. 추가 5계열 검색은
  발견 힌트이고 builder를 확정하지 않는다. 미완료 스캔을 우선 재개하고 정기 잡 호출을 추가했다.

## 실제 10개 결과

총 **141개 관측**: 지침 파일 138개, 도구 설정 3개. 이번 표본에서 실행 모델을 확정한 것은
**0개**다. 파일 존재를 실행 증명으로 잘못 승격하지 않은 결과다. 사이트에서 같은 저장소로
명시적으로 연결된 제품은 2개이며 나머지 8개는 관계 미확인으로 남겼다.
수집·표시 오류와 근거 부족을 구분하며, 이 표본 10개는 현재 기준 자동 발행 적격으로 승격하지 않는다.

| 제품 | 관측 수 | stars | GitHub 라이선스 | 사이트→저장소 | 화면 검사 |
|---|---:|---:|---|---|---|
| revealui | 54 | 4 | MIT | 미확인 | 통과 |
| colleague | 21 | 7 | Apache-2.0 | 미확인 | 통과 |
| goodboy-stop-re-explaining-yourself-to-ai-agents | 2 | 89 | MIT | 미확인 | 통과 |
| defang | 7 | 166 | MIT | 미확인 | 통과 |
| dotorixel | 20 | 1 | AGPL-3.0 | 미확인 | 통과 |
| brigade-trackable-work-for-coding-agent-fleets | 1 | 72 | MIT | 미확인 | 통과 |
| threa | 29 | 2 | MIT | 확인 | 통과 |
| tradinggoose-visual-workflow-platform-for-llm-trading | 2 | 137 | AGPL-3.0 | 확인 | 통과 |
| drever | 1 | 2 | MIT | 미확인 | 통과 |
| opanel | 4 | 285 | GPL-3.0 | 미확인 | 통과 |

각 페이지에서 HTTP 200, 브라우저 오류 0, 근거 URL 표시, 추정 AI 비노출, 실행 미확인 문구,
관계 미확인 문구, 데스크톱/390px 모바일 가로 넘침 없음을 확인했다.
TradingGoose 모바일 전체 화면도 저장하고 직접 검토했다.

## 실측에서 발견한 오류와 수정

1. 장기간 실행 중인 개발 서버가 이전 Drizzle schema 인스턴스를 캐시해 500 발생:
   migration 후 로컬 서버 재시작, 이후 10개 모두 200. 운영 문서에 재시작 절차 반영.
2. TradingGoose HTML 1,169,782바이트가 512KiB 검사 상한 초과:
   사이트 fingerprint만 2MiB 이내에서 전체를 검사하고 잘림은 관계 확정에서 제외.
   명시적인 `GitHub repository` 링크로 실제 제품 관계 확인.
3. Opanel 릴리스 100개 요청이 2,800,798바이트로 API 상한 초과:
   10개 페이지와 필요 시 1개 페이지로 제한. 2MiB 보호는 유지.
   수정 후 실제 릴리스 10개 수집 및 메타데이터 복구.

최초 실패와 재검증 원문:
[최초 수집](2026-09-06-agent-live-10-initial.json),
[수정 후 수집](2026-09-06-agent-live-10.json),
[최종 브라우저 검사](2026-09-06-agent-live-browser.json).

## 실행한 검증

- 전체 단위: `npm test` — 63개 파일, **517개 통과**.
- 전체 통합: `npm run test:integration` — 41개 파일, **395개 통과** (전용 DB 55435).
- `npm run test:e2e:product` — 프로덕션 빌드를 포함해 **3개 통과**, 최종 10.8초.
- `npx tsc --noEmit`, `npm run lint`, `git diff --check` 통과.
- 실제 로컬 10개 페이지: `node scripts/verify-agent-evidence-live.mjs` — **10개 통과**.
- GitHub 릴리스·사이트 크기 초과, private 전환, rate limit, 부분 재개, maker 보존, 발행 경합,
  다섯 모델 계열 라우팅의 정상/반례를 fixture 회귀로 검사했다. 5계열 모두를 실제 저장소
  표본으로 검증했다는 뜻은 아니다.

## 현재 실행 상태

- 로컬 Next 개발 서버 재시작: supervisor PID `43023`, 포트 3000.
- 별도 evidence 워커 PID `75975`, 기본 60초 대기 후 다음 틱.
- 첫 product/agent evidence 잡 둘 다 성공, `lastError=null`, DB cursor 저장을 확인했다.
  각각 25.7초 / 12.2초. 한 시점 워커 RSS 약 210MiB로 관측했으며 서버 용량 산정 벤치마크는 아니다.
- 로그: `/private/tmp/nomorevibe-evidence-worker.log`.
- 개발 DB flags: collection/display/eligibility 모두 켬. 기존 검색 설정을 보존하면서
  다섯 추가 검색을 명시적으로 병합했다. 워커는 evidence 두 잡을 실행한다.
- DB 백업: `/private/tmp/nomorevibe-before-agent-evidence-20260906.dump`.
  migration0019 적용 완료. 별도 Docker 포트3200/DB55437과 원격 서버는 변경하지 않았다.

로컬 프로세스는 Mac이 종료되면 멈춘다. 서버 상시 실행용 `scheduler.sh`는 두 evidence 잡을
매 틱 호출하도록 수정했지만 이 코드를 원격 서버에 배포한 상태는 아니다.

## 남은 범위

- 미확인 제품 관계 8건과 실행 모델은 제작자 신고 또는 더 강한 공개 근거가 있어야 확정 가능.
- 임의의 monorepo 하위 경로/외부 참조 파일 전체, 미공개 사용자 설정은 수집 범위 밖.
- 동일 1초 구간의 GitHub 1,000건 제한은 불완전으로 보존하며 완전 수집을 보증하지 않는다.
- 원래 계획의 50개 대표 저장소 검증·별도 audit CLI·태스크별 커밋·원격 배포는 수행하지 않았다.
  사용자 최종 요청의 실제 10개 테스트와 재수집 시작은 완료했다.
