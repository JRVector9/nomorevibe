# 2026-10-24 LLM 확인 경로의 운영 전환 기록

사용자가 남은 구현·운영 활성화·배포와 병렬 서브에이전트를 명시 지시했다. 원 사용자 WT를 보존하고
`nomorevibe-uptime-pre-delist-check`에서 작업한다. 이 문서의 실행과 미실행 항목을 구분한다.

## 현재 운영 실행

- 14:15:02Z, 실제 primary/active writer fence/lineage·epoch·제어 revision을 잠금·CAS로 확인한 TX에서 uptime만
  `confirm`, `confirmation_required=true`, `dispatch_enabled=false`, `apply_enabled=false`, revision2로 전환했다.
  audit19135. 후보 보존 단계이며 LLM 처리나 자동 적용 활성화가 아니다. 나머지5개 업무는 off다.
- 14:47:34Z readback은 uptime queued1, 전환 뒤 새 uptime 자동 내림0이다.
  기존 관측·차단 해제·제품 행은 직접 수정하지 않았다. 현재12복구후보가 모두 정상이라는 근거는 없다.
- abcLLM [PR5](https://github.com/JRVector9/abcLLM/pull/5)를 root가 검토하고274개 격리 회귀를 직접 재실행한 뒤
  main `5ae29cf5a7eb17367a62d0559a7773d41a79a15c`로 병합했다. 기존 M3/mini 이미지 ID와 서비스 spec을
  git밖0600으로 보존하고 `pre-native-20261024` 태그로 옛 바이트를 고정했다. autoDeploy는 켜져 있었으나
  실제 발동이 없어 명시 배포했다. mini done14:30:11Z를 검증한 뒤 M3 done14:31:30Z를 확인했다.
  양쪽 실제 container router hash는 `0a3f321de57434c4892efefb5ea95e0bc377fd74b0dcdd14ed481be30381add0`,
  strict marker true, health200/ok/Redis connected, Swarm completed였다(14:31:43Z).
  이후정상reviewer→공개gateway경로에서GPTOSS/supaQwen/GPUQwen raw+strict6회와일반nonraw1회가모두HTTP200/finishstop/유효usage였다. raw/strict의provenance는upstream_reported였다. 처음loopback1회는기존IP allowlist가handler진입전에403으로거절했고,allowlist/XFF위조없이정상출발지로고쳤다. 요청별실제gateway귀속은미확정이다. 이는종료증거기능의배포·호환canary이고모델별hard C·전역admission완료가아니다.

## 구현·실제 모델에서 발견한 결함

1. unclear+retain이 done이 되는 누락은 서버 검증을 보강했다. legacy/claims 실제 틱 회귀와 전용 DB 검증을 추가했다.
2. collector만60초 background 기한을 사용한다. 일반10초·uptime25초·연결/DNS/SSRF/origin/body/취소는 유지한다.
   수집과 모델은 동일 최대90초 신호를 공유하므로60+90초가 아니며 근거의180초 유효기간을 늘리지 않는다.
3. 첫 실제 GPU1회는 `/state/closed`를 반환해 semantic guard가 거절했다. uptime 출력 schema를 실제 필드
   `/state/page_state`, `/state/finding` enum으로 제한하고 구분 예시를 추가했다. 기존 wire버전·큐·다른4업무는 유지하고
   uptime 전용 revision2026-10-24.1과 실제 schema/prompt hash로 변경을 식별한다.
4. 수정 뒤 같은 고정17건을 직렬 비교했다. 실제 요청은 누적18(첫 실패1+새17), 재시도0, 원격 종료불명0.
   schema17/17, guard16/17, 검증 후 finding/facts14/17, rawfinding15/17이었다.
   결제402 `DEPLOYMENT_DISABLED` 두 건을 closed+delist로 잘못 제안했고 기존 guard도 통과했다.
   WebARkit은alive로 분류했지만 인용 변형으로 거절됐다. p50 2117ms/p95 5122ms.
   일시 중단 화면의 자동 내림을 막는 서버 guard를4bc64bac에서 보강했다. 저장 실제17응답 재생은14유효·호스팅안내2거절·기존인용변형1거절이었다. 실제 모델의 실패를 응답 교정으로 숨기지 않는다.
5. 최종 prompt `a9345c88…7f83d`로 같은 고정 근거4건을 추가 실행했다. 결제 중단2건은 모두 unclear/collect_evidence,
   명시적 종료1건은 closed/explicit_shutdown/delist_candidate로 검증됐다. WebARkit은 alive/retain이지만
   인용 변형으로 다시 거절됐다. schema4/4, guard·검증 후 일치3/4, rawfinding4/4, false-delist0,
   p50 2029ms/p95 6105ms다. 기존17건에서 고른 개발 회귀이며 새로운 사람 holdout으로 세지 않는다.
   이어 GPU에 고정128×96 PNG를1회 보내 왼쪽 파란 원·오른쪽 빨간 사각형을 정확히 확인했다.
   HTTP200/model qwen3.8-flash-next/finish stop/usage176, 469ms였다. 평가 누적23회(18+4+vision1),
   직렬1/재시도0/종료불명0이다. 이 측정만으로 production contract를 변경하지 않았다.

표본은 실제 스냅샷이지만 라벨 출처는 `codex_independent_pre_model`이며 개발 표본이다. 사람 독립 holdout이나
운영 오류율0을 주장하지 않는다. source/time/input을 고정한 offline direct 평가로, production domain freshness·
native admission·원장·전역 용량을 통과했다는 증거도 아니다. 사람에게17건 분류를 요청했고 아직 응답 전이다.

## 추가 운영 전제

- GPU actual vLLM C50000/max-num-seqs6, tp4/GPTQ Marlin/KV fp8_e5m2다. 이전262144를 복사하지 않는다.
  기존 Qwen direct 호출은 출력3000을 사용하므로 새 assist2048만으로 contract를 제한하면 기존 호출을 막는다.
- M3 실제 서버는oMLX0.7.1rc1이다. abcLLM PR2의mlx_lm.server patch를 이 서버에 적용할 수 없다.
  기존 oMLX는 prompt만 검사하고 요청max_tokens가4096설정을 덮으므로 전체 sequence hard C가 미보장됐다.
  exact source hash에 고정한 입력+유효출력+EOS 사전 거절 patch를 별도로 준비했고 실제 AST 경로9회귀를
  root도 실행해 통과했다. 새release overlay와PYTHONPATH entry를검증한뒤14:43:31Z SIGTERM을정확히1회보냈다.
  구PID48271의실제종료와새PID80130 KeepAlive재기동을확인했다. 원본sitepackages/plist/settings는보존했다.
  14:45Z 재로딩 중health503 뒤14:47:04Z health200/loaded2/loading0/active0/wait0을 확인했다.
  14:50:54Z 실제 HTTP8개 경계 canary도 완료했다. GPTOSS C131072·DeepSeek C262144 각각 stream/nonstream에서
  입력+출력+EOS 초과4개를 SSE 시작 전400/context_length_exceeded로 거절했고 정상max64 추론4개는
  JSON·finish stop·usage와 SSE DONE을 확인했다. 직렬1/재시도0, exact-fit 전체C 생성 부하는 실행하지 않았다.
  이는 API 경계 확인이며 production native ledger canary를 대신하지 않는다.
- oMLX 설정 동시1은 모델별 scheduler이고 장비 전체 독점 admission1의 증거가 아니다.
- 모든 gateway/CLI/local serving env 계약이 기존에는 없었다. 전역 capacity를 native assist route만 매핑해 열면
  기존 caller를 미루거나 누락하므로 그렇게 전환하지 않는다. ConnectAgent의 분류 CLI는 별도 후속 PR에서
  원격 프로세스 내부 reserve→dispatch→native terminal 정산으로 연결 중이다. 기존 제품 모델 설정은 유지한다.
- Oracle uptime unit은inactive/dead이고 기존 consumer는status-only다. 이를 이미 본문 확인 relay인 것으로 보고하지 않는다.
- 현재 global capacity는disabled이며 `globalReady=false`, 자동 적용 적격성도false다. 구현·배포와 이 상태를 섞지 않는다.

## 검증·산출물

통합596f4b09에서 root unit40건·실DB70건·typegen/tsc/변경TS ESLint를 실행했다.
포인터 수정474f1306에서 root unit46건을 확인했다. 이어 DB28건 중 legacy틱1건이 실패했고 조사 결과
Mac/Docker 시계차로 checked_at이 TX now보다3ms 미래여서 기존 안전 guard가 올바르게 거절했다.
진단SQL의 checked_at14:30:39.653/tx_now14:30:39.650015를 보존했다. 해당 회귀 관측을 DB시계-1초로
고정한 뒤 DB2파일28건 모두 통과했다. 생산의 미래 관측 보호는 변경하지 않았고 임시 진단 코드는 제거했다.
최종 코드4bc64bac에서 root가 단위5파일52건, 전용DB4파일72건, Next typegen·전체tsc·변경TS ESLint를
실행해 모두 exit0을 확인했다. 최종 후속 SHA의 전체 필수 CI와 배포 결과는 실제 종료 뒤 기록한다.

민감한 snapshot/SQL/env·서빙 원문·실제 응답은 git밖
`/private/tmp/nomorevibe-llm-activation-20261024/`의 readiness/evaluation/operations/omlx-hard-c 아래0700/0600으로 보존한다.
서브에이전트는 모두gpt-6.1-sol/xhigh다. gateway alias 진단의 discovery.scan(force=True)가 기존 Redis모델목록 cache TTL을
갱신했을 가능성은 진단 부작용으로 기록한다. 설정·제품·모델 결과를 바꾼 것으로 세지 않으며 추가 강제scan은 중단했다.
