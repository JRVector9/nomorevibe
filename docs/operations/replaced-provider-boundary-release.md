# 교체된 M1 경계의 단건 해제

`replaced_provider_boundary_exit`는 과거 gateway 요청 한 건에만 사용한다. 기존 V1~V4/CLI 경계 해제 계약은 변경하지 않는다. 종료된 원 요청의 업무 실패와 사용량 미확인은 그대로 남고, 장부 점유만 indeterminate→withdrawn으로 전환한다.

필수 근거:

- 계획의 정확한 request UUID, 전체 행의 PostgreSQL `to_jsonb(r)::text` SHA256, token SHA256, binding/정책/세대/원 dispatch 시각/C. 요청 배열이나 부분 일치는 거절한다.
- 현재 DRAIN의 epoch/revision/policyHash 및 마이크로초 updated_at, 활성 writer lineage/epoch. 같은 revision의 OPEN→DRAIN도 옛 계획을 재사용하지 못한다.
- 원 text worker의 append-only opened/intent/spawn/group_exited와 요청별 local-end. 해제 트랜잭션과 DB trigger가 실제 DB를 재조회한다. 시간 경과만으로는 승인하지 않는다.
- owner·M3 gateway·mini gateway 세 서비스의 Docker/Swarm 기록. 정확한 service/task/container, dispatch보다 늦은 시작, private PID namespace, 단일 현재 실행기, 살아 있는 이전 task 없음, 검토한 대체 ingress 없음. 현재 캡처는 계획 이후에 수집한다. raw 관측과 별도 검토 topology를 hash로 고정한다.
- M1 원 relay receipt의 endedAt/세대/모델/요청 hash 및 실제 복구 증거의 원 relay·모델 그룹 ESRCH. 현재 relay PID/세대/시작과 모델 교체도 별도로 읽는다. 이번 도구는 정지·재시작·sudo를 실행하지 않는다.
- 원 wire bytes와 relay wire bytes 각각의 SHA256 및 메시지·생성 상한 보존. 원 gateway 모델 `[m1] qwen3.8-flash-next`를 plain 모델로 바꾸고 stream=true/include_usage/thinking=false를 적용한 payload만 받는다. 실제 HTTPX0.27.2는 기본 Python `json.dumps`의 공백·ASCII escape·float를 사용한다. JSON 의미가 같다는 것만으로 hash 불일치를 허용하지 않는다. 두 원본 byte hash가 각각 장부/receipt와 일치해야 한다.

0139까지의 마이그레이션은 불변이다. 0140은 새 validators·행 전이 trigger·기존 CHECK 전체에 새 branch를 추가한다. 완전한 indeterminate predecessor를 검증하고 네 열(state/terminal_evidence/terminal_evidence_hash/updated_at) 외에는 변경을 금지한다. 운영에는 저장소의 정식 migration 절차로 설치하고 journal을 확인한다. 배포 보호는 해제 전에도 그대로 적용한다.

검토한 plan/receipt와 모든 SHA명 artifact는 private 파일로 준비한다. 원본에 인증 정보나 env를 복사하지 않는다. source/topology의 진위는 운영자가 원 Docker/Swarm/SSH 결과와 독립 대조해야 한다. hash만으로 자체 선언을 인증하지 않는다.

```text
node --import tsx scripts/ops/model-replaced-provider-boundary-release.ts
  --plan=/private/plan.json --plan-sha=<file-sha256>
  --receipt=/private/receipt.json --receipt-sha=<file-sha256>
  --artifact-dir=/private/hash-named-artifacts
  --operator=<operator> --reference=<plan.reviewReference>
  --database-url-stdin
```

DB URL은 stdin 한 줄만 받는다. 기본은 전체 쓰기·event·audit를 실행한 뒤 ROLLBACK하는 dry-run이다. 실제 검토 뒤 `--apply`를 추가한다. 오류 JSON의 missing은 누락/잘못된 계약 경로이며 입력값/자격정보는 출력하지 않는다. 성공 시 감사 action `model-replaced-provider-boundary-release`의 auditId를 반환한다. 응답이 불명확하면 동일 요청 readback을 우선하며 새 apply를 맹목 반복하지 않는다. 같은 근거의 재실행은 이미 해제됨으로 반환하고 새 event/audit를 추가하지 않는다.

2026-10-29 읽기 실측: 요청29877f65의 원 wire `0507685d…`를 당시199a3ebb 코드와 sourceHash 일치 원문4개에서 정확히 복원했다. 실제 gateway 변환과 HTTPX0.27.2 직렬화 뒤 `81d1f571…`로 원 relay6571d6c8와 일치한다. 이 해시 연결은 종료 근거 전체를 대신하지 않는다. 적용·감사·배포·새 업무 성공은 별도 실제 결과로만 기록한다.
