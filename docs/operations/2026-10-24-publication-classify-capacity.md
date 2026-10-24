# Publisher 분류의 native CLI 용량 연결

`crawl-publish`가 ConnectAgent에 보내는 자동 카테고리 분류를 고정 kind
`publication_classify_cli`, route `crawl-publish-classify`, background/reviewer 슬롯에 연결한다.
제품의 실제 우선 terra/xhigh·예비 sonnet/high 설정은 바꾸지 않는다. 이 문서는 구현·로컬 검증 기록이며
운영 활성화·배포·실제 모델 native canary 완료를 뜻하지 않는다.

Publisher가 전달하는 authority는 실제 publisher 역할 instance/boot/release/epoch와 job token/requestedVersion,
후보·문서·설정·수동 분류·작성 소개의 원본 hash, 분류 inputs/definitions hash, 원격 generation/configVersion/config hash다.
원격 프로세스가 reserve한 뒤 dispatch TX 안에서 해당 행과 wall-clock lease를 다시 잠그고 검증한다.
입력 재구성이나 하나의 source row라도 달라지면 spawn 전에 미룬다. DB 원본 hash는 microsecond 변경도 보존한다.
서로 일부만 겹치는 batch도 candidate member key로 owner/provider 변경에 걸쳐 차단한다.

실제 CLI argv/stdin/schema bytes는 기존 runner가 묶고, 원격 프로세스 안에서 원래 opaque terminal로 정산한다.
RPC JSON은 settlement 권한이 없다. 물리 종료를 확인하지 못한 자식은 indeterminate와 점유를 유지하고 fallback을 띄우지 않는다.
이 경우 해당 에이전트의 credential mutex도 유지한다. 일반 admission 대기·reserve 실패·spawn 전 취소는 mutex를 남기지 않는다.
새 TTL/watchdog/JSON 정산은 없다. 재시작도 역사적 indeterminate를 정산하지 않는다.

`disabled`는 기존 payload/adapter로 동작해 구버전 에이전트와 순차 배포가 가능하다.
`open`에서는 새 authority/계약 없는 구버전 호출을 미루며, ConnectAgent URL이 없을 때의 direct CLI fallback도 spawn하지 않는다.
typed defer는 분류 hold·발행 실패 횟수·후보 상태를 바꾸지 않는다. 최종 발행의 기존 source/manual decision CAS는 그대로다.
원격 status를 못 읽으면 호출 전에 미루고, native 요청 뒤 RPC 응답 유실도 결과 불명으로 미룬다.
원격 프로세스의 독립적인 opaque terminal 정산을 caller의 네트워크 오류로 대신하지 않는다.
작업 권한이 없는 관리자 `probe`/`test`는 disabled에서 기존 동작, open/draining에서는 typed defer와 설명 오류를 반환한다.
계정 연결·기존 설정 적용 자체를 새 publication 권한으로 위장하지 않는다.

Pipeline-control은 15초 안의 단일 ConnectAgent 관측에 담긴 실제 primary/fallback 각각을 분모에 포함한다.
구버전·미상·미래·오래된 관측, busy, 계약 누락/중복/불일치는 global open 준비 통과가 아니다.
CLI 계약은 ConnectAgent의 `CLI_SERVING_CONTRACTS`로 주입하고 시작 시 실제 `--version`이 일치해야 resolver가 연다.
독립 pipeline-control 도구도 같은 local startup version probe를 기다린 뒤 판단한다.
도구가 실행되는 프로세스의 reviewer CLI 계약과 원격 ConnectAgent 관측 계약은 서로 바꾸어 쓰지 않는다.
정책의 두 route tuple은 기존 구독 계정별 provider budget과 물리 그룹에 연결해야 한다.
활성화 전 disabled에서 시작한 legacy 호출이 끝나도록 draining 뒤 실제 idle과 fresh 관측을 확인한다.
새 호출 중단만으로 이미 실행 중인 legacy 모델이 끝났다고 판단하지 않는다.

Migration `0125_publication_classify_cli`는 기존 다섯 CHECK의 전체 predicate를 왼쪽에 보존하고 새 고정 kind 분기만 OR로 더한다.
Zod/SQL strict shape·member·identity·canonical input hash·historical dispatch를 검증한다.
SQL의 JSON null provenance 우회는 실제 RED 재현 뒤 `IS DISTINCT FROM`으로 막았다.
다른 required string enum 및 owner/transport identity의 JSON null 변종도 거절한다.
UUID 모양만 맞고 RFC version/variant가 다른 job token도 Zod와 SQL 모두 거절한다.

운영 계약 후보는 다음 두 개다. 아직 환경에 설치하지 않았다. 입력 cap은 UTF-8 argv+stdin+schema bytes 합이며
100000을 넘으면 spawn 전에 미룬다. 기존 RPC 분류 data cap64KiB를 보존하고 고정 authority를 위한 전체8KiB 여유만 더한다.

```json
[
  {"version":1,"protocol":"cli-process-v1","routeId":"crawl-publish-classify","provider":"codex-cli","model":"gpt-5.6-terra","cliVersion":"codex-cli 0.153.4","inputByteCap":100000,"totalTokenBound":272000,"costBoundUsdMicros":null,"boundProvenance":"declared"},
  {"version":1,"protocol":"cli-process-v1","routeId":"crawl-publish-classify","provider":"claude-cli","model":"sonnet","cliVersion":"2.1.263 (Claude Code)","inputByteCap":100000,"totalTokenBound":252000,"costBoundUsdMicros":null,"boundProvenance":"derived","maxTurns":2,"outputTokensPerTurn":4000,"overheadTokenBound":20000}
]
```

Codex의 272000은 실제 선택 모델의 `models_cache.json` context_window에서 읽었다(effective95%).
현재 argv에는 누적 토큰·출력·비용의 hard flag가 없으므로 이 값은 declared이며 누적 hard bound로 주장하지 않는다.
공통 admission은 기존 개수 기준이고 C는 활성화 판정에 쓰지 않는다. 비용 상한은 null이다.
Claude의252000은 기존 공식 `2*(100000+20000)+3*4000`이다. 기존 turns2/output4000 설정을 유지하며,
overhead20000과 byte-level token 가정은 명시적 운영 가정으로 남긴다. 새 서버 실측값으로 표현하지 않는다.
계약 hash는 Codex `20b9caa4d048ba09b484da5045cbbf43045d930c7672b1fb55a08e4a9621f285`,
Claude `43e7a76005ca9eddb37059086b38bfa2c5c5ca29e3c864a1dff1ec54aa3f0236`다.
비밀 없는 원본 readback·계약 후보는 git 밖
`/private/tmp/nomorevibe-llm-activation-20261024/readiness/{connect-agent-status-readback,connect-agent-cli-readback,connect-agent-model-context-readback,publication-classify-cli-contract-proposal}.json`에 있다.

전용 loopback pgvector DB에서126개 migration fresh 설치와 기존 CLI ledger8건을 실행했다.
새 native 통합17건은 실제 가짜 CLI process만 띄웠다(PATH에 실제 모델 CLI 없음): source/lease/config 변경9종 spawn0,
유효 정산, null provenance 실제 CHECK 거절, string enum/identity null15변종, 종료 후 다른 provider fallback,
실제 관측의 readiness/stale 차단, missing status의 spawn0, UUID version/variant, 종료 불명·owner/provider 교체 후 member fence를 확인했다.
구체 명령·최종 테스트 수와 실행 결과는 `docs/CODEX_HANDOFF.md`를 따른다. 실제 모델 호출은 이 구현 단계에서0이다.
