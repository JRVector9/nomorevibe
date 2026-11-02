# M1 relay·상품 번역 등록부 연결 — 대표 실행 안내 (2026-10-29)

코드: [PR #732](https://github.com/JRVector9/nomorevibe/pull/732), 병합 main **`279e596ee267e39b311d329ef828f4d9fe9946e7`**(`a900db03` 코드·`6143ded5` 문서를 main `49cd9330`에 합친 것). 아래는 모두 **대표 실행용이고 작업자는 실행하지 않았다**(운영 DB 쓰기·원격 SSH·배포·relay 재설치·0143 모두 0). 위치 표시는 `[gpu3090]`(대표 셸), `[m3]`(`xa-ssh m3ultra`), `[m1 device_admin]`(m1studio root argv)이다.

바뀐 동작 요약: relay 허용 모델 = 등록부에서 `LOCAL_MODEL_RELAY_EQUIPMENT`(기본 `m1`) 장비의 `relay` 용도 entry(기본값은 `m1:translation` = `mlx-community--gemma-4-26b-a4b-it-4bit` 하나). 상품 번역 = 등록부 `m1:translation`. 옛 `PRODUCT_TRANSLATION_MODEL=[m1] qwen3.8-flash-next`는 같은 M1 장비의 현재 등록 모델 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`로 해석된다.

## 0. 확정본(release-order)과의 관계 — 먼저 읽기

- (2026-10-29 확정본 3판에서 갱신) 확정본·사전 점검 묶음의 `REL`은 이 변경이 들어 있는 `f4fe5958290713d95e2ce618126fbbf651cd3d95`(PR #735 병합 main)이다. 배포 `TARGET`은 고정값이 아니고 plan 시점의 main 머리다(확정본 3절 「배포 TARGET」). 이전 판의 `1f52c9ef…`는 더 쓰지 않는다. 확정본 17단계가 이 안내 1절(설치본 `279e596e…`, 전·후 읽기)을 그대로 쓰고, bootstrap 전 `server.ts check`와 되돌리기를 더했다.
- relay는 Dokploy 배포와 별개로 M1에 따로 설치한다. 그래서 **relay 설치본 SHA는 `279e596ee267e39b311d329ef828f4d9fe9946e7`**로 한다(이 변경이 들어 있는 main). Dokploy `TARGET`과 같을 필요는 없다. relay가 읽는 파일은 `279e596e`와 확정본 `REL` 사이에 차이가 없다. 확정본 17단계의 `<REVIEWED_SHA>`와 성공 조건 「plist `LOCAL_MODEL_RELAY_VERSION`」은 이 값이다.
- `1f52c9ef` relay도 plist에 `LOCAL_MODEL_RELAY_MODEL=mlx-community--gemma-4-26b-a4b-it-4bit`를 주면 Gemma를 허용한다(인계 argv가 그렇게 쓴다). 새 SHA에서 더해진 것은 장비 한정(다른 장비 모델 거절)과 추론 전 상류 `/v1/models` 대조(`503 upstream_model_mismatch`/`upstream_models_unavailable`), health의 `allowedModels`·`upstreamModelReason`이다.
- **relay 재시작 시점 제약은 그대로다**: M1 미확인 해제(확정본 12단계) 전에 재시작하면 `recovery.newRelayPid ≠ 현재 PID`가 되어 해제 경로가 영구히 막힌다. 재설치는 확정본 17단계 자리에서만 한다.

## 1. relay 재설치 (확정본 17단계 자리, [m1 device_admin])

- `<REVIEWED_SHA>` = **`279e596ee267e39b311d329ef828f4d9fe9946e7`**(40자리 그대로). 설치본 경로: `/var/tmp/nmv-relay-reviewed/279e596ee267e39b311d329ef828f4d9fe9946e7` → `/usr/local/nmv-llm-relay/releases/279e596ee267e39b311d329ef828f4d9fe9946e7`.
- 설치본 준비·해시 기록·ditto·plist·config.env·bootout/bootstrap argv는 [M1 relay 인계](2026-10-29-m1-relay-model-handoff.md) 「대표용 M1 argv」를 그대로 쓰고 `<REVIEWED_SHA>`만 위 값으로 바꾼다. 준비 때 `find /var/tmp/nmv-relay-reviewed/279e596ee267e39b311d329ef828f4d9fe9946e7 -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256` 값을 적고, ditto 직전에 같은지 다시 본다(확정본 17단계와 같다).
- 설치본 검토용 원본 해시(`git show 279e596e…:<파일> | sha256sum`, 작업자가 계산). 준비한 설치본의 같은 파일을 `shasum -a 256`으로 대조한다:

| 파일 | SHA-256 |
| --- | --- |
| `scripts/local-model-relay/config.ts` | `9c8fdbf814417332096b1d294a00232e7c025b6ad62f661ed1c07f9ea9bff8d5` |
| `scripts/local-model-relay/server.ts` | `210456e7f9c10f43a76512c1e9308f760447828aa792df0943c5cee86d458404` |
| `scripts/local-model-relay/service.ts` | `cf79a0ff5b3d6455bfe41aeb9add7b036f75a925524956e27809d76b65385b3a` |
| `lib/llm/model-registry.ts` | `c2cef4a646f906ada5f9443d1a7da70c76f8693870431471bf8de8d74ec7def8` |
| `scripts/ops/local-model-relay.sh` | `3b6415c84aa84f734157075f8346058fafa3e33421e08d7a89ffe1947828f102` |
| `package-lock.json` | `f609ff6e3159975cce362809a50bc335afb2a812502fb74d70c8ab3a203296d5`(1f52c9ef와 같음) |

재설치 **전** 읽기(쓰기 0) — 지금 plist가 등록부를 따로 받는지, 모델 고정값이 무엇인지:
```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/usr/bin/python3","-I","-c","import plistlib; d=plistlib.load(open('/Library/LaunchDaemons/bot.brut.nmv-llm-relay.plist','rb')); e=d.get('EnvironmentVariables',{}); print({k:e.get(k) for k in ('LOCAL_MODEL_RELAY_MODEL','LOCAL_MODEL_RELAY_MODEL_KEY','LOCAL_MODEL_RELAY_MODEL_FAMILY','LOCAL_MODEL_RELAY_EQUIPMENT','LOCAL_MODEL_RELAY_VERSION')}); print('MODEL_REGISTRY_CONFIG', 'set' if e.get('MODEL_REGISTRY_CONFIG') else 'unset')"]}
```
- 기대: `MODEL_REGISTRY_CONFIG unset`(설치기 `scripts/ops/local-model-relay.sh`의 plist env 목록에 이 변수가 없다). `LOCAL_MODEL_RELAY_EQUIPMENT`는 `None`(기본 `m1`). `LOCAL_MODEL_RELAY_MODEL`이 `qwen3.8-flash-next`로 남아 있으면 새 relay는 `relay_model_not_allowed`로 시작하지 않는다 — 인계 argv의 plist·config.env 갱신 줄이 Gemma 값으로 바꾸므로 그 줄을 빼먹지 않는다.

재설치 **후** 읽기(쓰기 0):
```jsonl
{"executable":"/usr/bin/perl","args":["-e","alarm 55; exec @ARGV; die $!","/bin/bash","/usr/local/nmv-llm-relay/current/scripts/ops/local-model-relay.sh","status"]}
```
- 성공: JSON에 `"allowedModels":["mlx-community--gemma-4-26b-a4b-it-4bit"]`, `"upstreamModelMatch":true`, `"upstreamModelReason":"matched"`가 있다. `relayRevision`이 `279e596ee267e39b311d329ef828f4d9fe9946e7`다. `upstream_model_mismatch`면 oMLX가 다른 모델을 서빙 중이다 — 추론은 relay가 전송 전에 거절하므로 미확인이 생기지 않는다. 멈추고 oMLX `/v1/models`를 확인한다.
- `status_unavailable`·launchd `last exit code` ≠ 0이면 `relay.log`의 `invalid_config`를 본다. 이 SHA에서 새로 생길 수 있는 시작 거절은 `relay_model_not_allowed`(plist 모델이 M1 relay entry가 아님)·`relay_model_not_registered`(등록부에 M1 relay entry 없음 — plist에 옛 JSON을 넣었을 때만)·`relay_invalid_equipment`다. 시작이 거절되면 인계 문서의 backup으로 되돌린다.

## 2. 운영 `MODEL_REGISTRY_CONFIG` — M1 `relay` 용도 항목이 필요한가

| 어디 | 필요 여부 | 근거 |
| --- | --- | --- |
| M1 relay(plist) | **불필요**(지금 설치 방식 그대로면) | 설치기 plist env에 `MODEL_REGISTRY_CONFIG`가 없어 relay는 중앙 기본값을 읽고, 기본값의 `relay` 용도는 `m1:translation`에 있다. 누군가 plist에 JSON을 넣는다면 그 JSON의 M1 entry에 `relay`가 있어야 한다(없으면 `relay_model_not_registered`). |
| 앱(web·text·maintenance·scheduler 등) | `relay` 용도 자체는 **불필요**(앱 코드에 `relay` 용도 소비자가 없다) | 다만 앱이 `MODEL_REGISTRY_CONFIG`를 쓰고 있으면 그 JSON의 `m1:translation`이 옛 Qwen일 수 있어 상품 번역에는 이전이 필요하다. 이전 도구가 `relay`까지 함께 넣으므로 아래 후보를 그대로 쓴다. |

앱 컨테이너가 등록부 JSON·번역 키를 쓰는지 읽기 [m3]. text 소비자 앱은 runbook 기록의 `nomorevibe-text-m3-ebmybu`다(아니면 Dokploy 화면의 text-m3 appName으로 `TCID` 줄만 바꾼다). 값 자체는 출력하지 않고 설정 여부와 해석 결과만 본다:
```sh
DK='env PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin docker'
TCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=nomorevibe-text-m3-ebmybu); echo "$TCID"   # 정확히 1줄
xa-ssh m3ultra "$DK exec $TCID sh -c 'printenv SERVICE_INSTANCE_ID; for v in MODEL_REGISTRY_CONFIG PRODUCT_TRANSLATION_MODEL_KEY PRODUCT_TRANSLATION_MODEL; do if [ -n \"\$(printenv \$v)\" ]; then echo \$v=set; else echo \$v=unset; fi; done; printenv PRODUCT_TRANSLATION_MODEL_KEY; printenv PRODUCT_TRANSLATION_MODEL'"
xa-ssh m3ultra "$DK exec -w /app $TCID node --import tsx -e 'const m=require(\"./lib/llm/model-registry\"); const d=m.configuredModelDefinition(\"product-translate\"); console.log(JSON.stringify({key:d.key,equipment:d.equipment,provider:d.provider,requestModel:m.configuredModel(\"product-translate\")}))'"
```
- 기대(설정 후): `{"key":"m1:translation","equipment":"m1","provider":"abcllm","requestModel":"[m1] mlx-community--gemma-4-26b-a4b-it-4bit"}`. 이 명령은 `1f52c9ef` 이미지와 새 이미지 모두에서 돈다(두 함수 모두 있다).
- `MODEL_REGISTRY_CONFIG=set`이면 [gpu3090]에서 후보 JSON을 만든다. 운영 값은 대표가 Dokploy 화면에서 복사해 `registry-before.json`으로 저장한다(작업자는 운영 값을 보지 않았다):
```sh
SRC=/home/ubuntu/projects/nomorevibe; N=279e596ee267e39b311d329ef828f4d9fe9946e7; M=$HOME/nmv-registry-$N
git -C "$SRC" fetch origin main
git -C "$SRC" merge-base --is-ancestor "$N" origin/main && echo ancestor_ok
mkdir -p "$M"
git -C "$SRC" archive "$N" lib scripts tsconfig.json package.json | tar -x -C "$M"
ln -s "$SRC/node_modules" "$M/node_modules"
cd "$M"
node --import tsx scripts/migrate-model-registry-m1.ts --print-migration < "$HOME/registry-before.json" > "$HOME/registry-candidate.json"
diff <(python3 -I -m json.tool "$HOME/registry-before.json") <(python3 -I -m json.tool "$HOME/registry-candidate.json")
```
(공유 checkout의 작업 트리를 바꾸지 않도록 archive를 따로 푼다. 확정본 표 3의 `$T` 방식과 같다.)
- 기대 diff: `m1:translation`의 `model`·`family`·`displayName`이 Gemma 값이 되고 `purposes`에 `product-translate`·`reason-translate`·`relay`가 있으며, `selections`에 `"product-translate"`·`"reason-translate"`·`"relay"`가 모두 `"m1:translation"`이다. 다른 entry·주소·기한·후보는 바뀌지 않는다.
- 참고 후보(운영 JSON이 **1f52c9ef 중앙 기본값과 같다고 가정한 경우**, 작업자가 `279e596e` 코드의 이 도구로 실제 생성): [2026-10-29-model-registry-candidate-m1-relay.json](2026-10-29-model-registry-candidate-m1-relay.json)(sha256 `1721021404dc08dd2e1a3423de90846a756eb94dd3fce57fbf494f0c452eeca7`). 이 후보로 `relayModelDefinitions("m1")`=`[m1:translation]`, `product-translate` route=`[m1] mlx-community--gemma-4-26b-a4b-it-4bit`(옛 `PRODUCT_TRANSLATION_MODEL=[m1] qwen3.8-flash-next`가 남아 있어도 같음)임을 확인했다. 기본값과의 차이는 위 기대 diff의 `relay` 용도·세 selection뿐이다. 운영 JSON이 다르면 이 파일이 아니라 위 명령 출력을 쓴다.

## 3. `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation`

- 상품 번역 소비자(text-m3·mini 예비 text, 표시를 위해 web 2곳)의 Dokploy env에 `PRODUCT_TRANSLATION_MODEL_KEY=m1:translation`을 둔다. KEY가 옛 `PRODUCT_TRANSLATION_MODEL`보다 우선한다. `1f52c9ef`에서도 KEY는 동작한다. 새 main 이미지는 KEY가 없어도 옛 `[m1] qwen3.8-flash-next`를 Gemma로 해석하지만, 설정 정리는 KEY로 한다.
- 실제 env 변경과 재배포는 `deployment-fast-path.md`의 일반 배포 절차를 따른다(이 안내는 변경 명령을 주지 않는다). 확정본 진행 중이면 16단계 배포 전에 env를 넣어 같은 배포로 반영하는 것이 재배포를 한 번 줄인다.

## 4. 용량 정책의 `product-translate` route 모델 확인 (READ ONLY, [m3])

route 모델이 `[m1] mlx-community--gemma-4-26b-a4b-it-4bit`가 아니면 그 호출은 `unmapped`로 보류된다(확정본 2(b)·18단계 `routes`의 non-serving에도 나온다). 실행기는 사전 점검 묶음 5절 (c)의 `run.mjs`(컨테이너 `DATABASE_URL`, READ ONLY 트랜잭션, 5초 제한)와 같다.
```sh
W=$HOME/nmv-m1-registry-check; mkdir -p "$W"
CCID=$(xa-ssh m3ultra $DK ps -q --no-trunc --filter label=com.docker.swarm.service.name=app-generate-haptic-card-vjqgv4); echo "$CCID"   # crawler-m3, 정확히 1줄
cat > "$W/run.mjs" <<'EOF'
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
try {
  const rows = await sql.begin("read only", async (tx) => { await tx.unsafe("SET LOCAL statement_timeout = 5000"); return tx.unsafe(text); });
  console.log(JSON.stringify(rows, null, 1));
} finally { await sql.end({ timeout: 5 }); }
EOF
cat > "$W/P1.sql" <<'EOF'
SELECT c.mode, c.epoch, c.revision, c.policy_hash, r->>'routeId' AS route_id, r->>'provider' AS provider, r->>'model' AS model,
  r->>'groupId' AS group_id, r->>'providerBudgetId' AS provider_budget_id
FROM model_capacity_control c CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.policy->'routes','[]'::jsonb)) r
WHERE c.id = 1 AND r->>'routeId' IN ('product-translate','reason-translate')
ORDER BY 5, 7;
EOF
python3 -I -c 'import json,sys;print("const text="+json.dumps(open(sys.argv[1]).read())+";");print(open(sys.argv[2]).read())' "$W/P1.sql" "$W/run.mjs" > "$W/P1.mjs"
xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/P1.mjs" | tee "$W/P1.json"
```
- 성공: `route_id=product-translate`, `provider=abcllm`, `model=[m1] mlx-community--gemma-4-26b-a4b-it-4bit`인 행이 있고 그 `group_id`가 M1 물리 그룹이다. `[m1] qwen3.8-flash-next` 행만 있으면 정책 갱신은 기존 감사 절차(DRAINING → 정책 → OPEN)로 별도 승인한다. 이 안내는 정책을 쓰지 않는다.
- 같은 판정을 앱 env 기준으로 보려면 확정본 2(b)의 `capacity-control.sh routes` 출력에서 `product-translate` 줄의 status가 `serving`인지 본다.

## 5. 배포 뒤 번역 저장 증가 확인 (READ ONLY, [m3])

배포(또는 env 반영) 시각을 `T0`(UTC, 예 `2026-10-30 01:00:00+00`)로 적고, 그 전후를 같은 실행기로 센다. 제품 번역은 10/28 16:01 KST 이후 0건이었다.
```sh
cat > "$W/P2.sql" <<'EOF'
SELECT date_trunc('hour', updated_at) AS hour, status, model, count(*) AS rows
FROM product_translations
WHERE updated_at >= now() - interval '6 hours' AND status IN ('ready','failed')
GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3;
EOF
cat > "$W/P3.sql" <<'EOF'
SELECT status, count(*) AS rows, max(updated_at) AS last_update
FROM product_translations GROUP BY status ORDER BY status;
EOF
for q in P2 P3; do python3 -I -c 'import json,sys;print("const text="+json.dumps(open(sys.argv[1]).read())+";");print(open(sys.argv[2]).read())' "$W/$q.sql" "$W/run.mjs" > "$W/$q.mjs"; xa-ssh m3ultra "$DK exec -i $CCID node --input-type=module -" < "$W/$q.mjs" | tee "$W/$q-$(date -u +%H%M).json"; done
```
- 성공: `T0` 뒤 시간대에 `status=ready`, `model`에 `gemma-4-26b`가 들어간 행이 생기고 늘어난다. P3의 `ready` 수와 `last_update`가 `T0` 전 값보다 크다. `pending` 수가 줄어드는지는 30분·2시간 뒤 다시 P3로 본다.
- `failed`만 늘면 `error_code`를 본다: `SELECT error_code, count(*) FROM product_translations WHERE updated_at >= now() - interval '1 hour' AND status='failed' GROUP BY 1 ORDER BY 2 DESC;`(같은 실행기). 0건이 이어지면 사전 점검 묶음 5절 (e) R1과 관문 문서 S2(`defer:product-translate`의 마지막 미룸 이유)를 본다.
- 실제 증가는 이 실행 결과로만 기록한다. 작업자는 측정하지 않았다(측정 없음).

## 6. 이 안내의 검증 (작업자, 2026-10-29)

- 4·5절 SQL 4개(P1·P2·P3와 `failed` 이유 SELECT)를 사전 점검 묶음과 같은 READ ONLY 실행기(`run.mjs` + stdin 모듈)로 **임시 로컬 postgres 17**(같은 열 이름의 최소 테이블과 표본 행)에 돌려 오류 없이 위 기대 형식이 나옴을 확인했다. 운영 DB·개발 DB에는 실행하지 않았다.
- 2절 컨테이너 안 node 식을 이 저장소에서 같은 따옴표 형태(`sh -c "… -e '…\"…\"…'"`)로 실행해 `{"key":"m1:translation",…,"requestModel":"[m1] mlx-community--gemma-4-26b-a4b-it-4bit"}`를 확인했다. `configuredModelDefinition`·`configuredModel`은 `1f52c9ef`에도 있다.
- 0·1절의 relay 동작은 [PR #732](https://github.com/JRVector9/nomorevibe/pull/732) 코드와 시험(`tests/m1-relay-model-config.test.ts`·`tests/local-model-relay*.test.ts`)에 근거한다. 실제 M1 설치·health·번역 저장 증가는 측정 없음(대표 실행 몫).
