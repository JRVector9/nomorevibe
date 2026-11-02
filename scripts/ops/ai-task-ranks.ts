/**
 * 「작업 ↔ 모델」 순위를 배포 창 안에서(capacity DRAINING) 화면 없이 다룬다 — 화면(/admin/models/tasks)과 같은 함수를 부른다.
 *
 *   node --import tsx scripts/ops/ai-task-ranks.ts status [--json]
 *   node --import tsx scripts/ops/ai-task-ranks.ts preview [--json]                 가져오기 계획(쓰지 않는다, 키는 이름만). 계획을 못 만들 때만 종료 코드 1
 *   node --import tsx scripts/ops/ai-task-ranks.ts apply --hash=<64hex> --operator=<이름>  계획 hash 가 같을 때만 적용(경고는 stderr 「경고 …」 줄)
 *   node --import tsx scripts/ops/ai-task-ranks.ts resave --operator=<이름> [--task=a,b]  저장된 순위를 그대로 다시 저장(빠진 계약·정책 route·장비를 만든다)
 *   node --import tsx scripts/ops/ai-task-ranks.ts set --operator=<이름> --task=<작업> [--slot=N] --rank1='<연결 이름>|<모델>' [--rank2=…]  한 칸을 화면처럼 저장
 *
 * DATABASE_URL 은 앱과 같은 것을 쓴다(웹·워커가 읽는 env 로 「지금 실제로 쓰는 모델」을 판정하므로 운영 컨테이너 안에서 돌린다).
 * 가져오기는 키가 필요한 새 연결의 키를 옮길 수 없어도(이 컨테이너에 키 암호화 설정 NMV_SECRET_BOX_KEY 가 없거나 그 키를 읽지 못함) 멈추지 않는다 —
 * 그 연결을 키 없이 만들고 순위도 적용한 뒤 연결 이름마다 경고를 싣는다(종료 코드 0, 2026-11-02 사람 결정 「키 없어도 배포는 되게」). 키 없는 연결은 실행 쪽이
 * 부르지 않고 다음 순위로 넘기고(connection_key_missing), 웹·워커가 같은 주소의 계약 키로 채우며(ai-connection-key-fill), 관리자가 다른 모델을 고를 수도 있다.
 * 키를 옮겨 두려면 키 암호화 설정이 있는 웹·워커 컨테이너에서 돌린다.
 */
import { applyAiTaskImport, previewAiTaskImport, readAiTasksAdminView, saveAiTaskRanks } from "@/lib/operations/admin-ai-tasks-repository";

type RankArg = { connection: string; model: string } | null;
type Args = { command: string; json: boolean; hash: string | null; operator: string | null; tasks: string[] | null; slot: string | null; ranks: RankArg[] };

export function parseAiTaskRanksArgs(argv: readonly string[]): Args {
  const [command = "", ...rest] = argv;
  const value = (name: string) => rest.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const tasks = value("task");
  // --rankN=<연결 이름>|<모델> — 1부터 빈칸 없이(빈칸·중복은 저장 검증이 막는다)
  const ranks: RankArg[] = [];
  for (const n of [1, 2, 3]) {
    const raw = value(`rank${n}`);
    if (raw === null) break;
    const cut = raw.indexOf("|");
    ranks.push(cut > 0 && cut < raw.length - 1 ? { connection: raw.slice(0, cut), model: raw.slice(cut + 1) } : null);
  }
  return { command, json: rest.includes("--json"), hash: value("hash"), operator: value("operator"),
    tasks: tasks ? tasks.split(",").map(task => task.trim()).filter(Boolean) : null, slot: value("slot"), ranks };
}

/** 명령 하나를 돌려 종료 코드를 돌려준다(0 성공 — 경고만 있어도, 1 거절·실패, 2 사용법). */
export async function runAiTaskRanks(argv: readonly string[]): Promise<number> {
  const args = parseAiTaskRanksArgs(argv);
  if (args.command === "status") {
    const view = await readAiTasksAdminView();
    const slots = view.slots.map(slot => ({ task: slot.task.id, slot: slot.slot, label: slot.label, live: slot.live,
      ranks: slot.rows.map(row => ({ rank: row.rank, connection: view.connections.find(entry => entry.id === row.connectionId)?.label ?? row.connectionId, model: row.model })),
      current: slot.currentLabels, sameAsCurrent: slot.sameAsCurrent, skip: slot.current?.skip ?? null,
      blocking: slot.readiness.flatMap(row => row.blocking), warnings: slot.readiness.flatMap(row => row.warnings) }));
    const out = { connections: view.connections.map(row => ({ label: row.label, kind: row.kind, baseUrl: row.baseUrl, cliTool: row.cliTool, hasKey: row.hasKey,
      models: row.models?.length ?? null, modelsError: row.modelsError, deviceId: row.deviceId })), slots, errors: view.errors, secretBox: view.secretBox, policyMode: view.policyMode };
    if (args.json) console.log(JSON.stringify(out));
    else for (const slot of slots) console.log(`${slot.task}#${slot.slot} ${slot.ranks.map(row => `${row.rank}:${row.connection}·${row.model}`).join(" ") || "(순위 없음)"}`
      + ` | 지금: ${slot.current.join(", ") || "-"}${slot.sameAsCurrent === false ? " ≠" : ""}${slot.blocking.length ? ` | 막힘 ${slot.blocking.join("; ")}` : ""}`);
    return Object.keys(view.errors).length ? 1 : 0;
  }
  if (args.command === "preview") {
    const preview = await previewAiTaskImport();
    if (args.json) console.log(JSON.stringify(preview));
    else {
      console.log(`hash=${preview.hash ?? "-"} error=${preview.error ?? "-"}`);
      for (const row of preview.plan?.connections ?? []) console.log(`연결 ${row.action} ${row.label} ${row.kind} ${row.baseUrl ?? row.cliTool ?? ""}`);
      for (const row of preview.plan?.slots ?? []) console.log(`칸 ${row.action} ${row.task}#${row.slot} ${row.ranks.map(rank => `${rank.rank}:${rank.connectionKey}·${rank.model}`).join(" ")}`);
      for (const warning of preview.plan?.warnings ?? []) console.log(`경고 ${warning}`);
    }
    // 키를 옮기지 못하는 연결(keyWarnings)은 경고일 뿐이다 — 경고 맨 앞 줄에 보이고 종료 코드는 0(계획을 못 만들었을 때만 1)
    return preview.error ? 1 : 0;
  }
  if (args.command === "apply") {
    if (!args.hash || !args.operator) { console.error("usage: apply --hash=<64hex> --operator=<이름>"); return 2; }
    const result = await applyAiTaskImport(args.hash, args.operator);
    console.log(JSON.stringify(result));
    // stdout 은 결과 JSON 한 줄 그대로 두고, 경고(키 없이 만든 연결 등)는 사람이 보도록 stderr 에 한 줄씩
    if (result.ok) for (const warning of result.warnings) console.error(`경고 ${warning}`);
    return result.ok ? 0 : 1;
  }
  if (args.command === "resave") {
    if (!args.operator) { console.error("usage: resave --operator=<이름> [--task=a,b]"); return 2; }
    const view = await readAiTasksAdminView();
    let failed = 0;
    for (const slot of view.slots) {
      if (!slot.rows.length || (args.tasks && !args.tasks.includes(slot.task.id))) continue;
      const ranks = [1, 2, 3].map(rank => { const row = slot.rows.find(entry => entry.rank === rank); return row ? { provider: row.connectionId, model: row.model } : null; });
      const result = await saveAiTaskRanks({ task: slot.task.id, slot: slot.slot, revision: slot.revision, ranks }, args.operator);
      if (!result.ok) failed += 1;
      console.log(JSON.stringify({ task: slot.task.id, slot: slot.slot, ...result }));
    }
    return failed ? 1 : 0;
  }
  if (args.command === "set") {
    const slotNo = Number(args.slot ?? "1");
    if (!args.operator || !args.tasks || args.tasks.length !== 1 || !args.ranks.length || !Number.isInteger(slotNo)) {
      console.error("usage: set --operator=<이름> --task=<작업> [--slot=N] --rank1=<연결 이름>|<모델> [--rank2=…] [--rank3=…]"); return 2;
    }
    const view = await readAiTasksAdminView();
    const slot = view.slots.find(entry => entry.task.id === args.tasks![0] && entry.slot === slotNo);
    if (!slot) { console.error(`unknown_task_slot ${args.tasks[0]}#${slotNo}`); return 2; }
    const ranks = args.ranks.map(choice => {
      if (!choice) return null;
      const connection = view.connections.find(entry => entry.label === choice.connection);
      if (!connection) throw new Error(`unknown_connection ${choice.connection}`);
      return { provider: connection.id, model: choice.model };
    });
    const result = await saveAiTaskRanks({ task: slot.task.id, slot: slot.slot, revision: slot.revision, ranks }, args.operator);
    console.log(JSON.stringify({ task: slot.task.id, slot: slot.slot, ...result }));
    return result.ok ? 0 : 1;
  }
  console.error("usage: status|preview|apply|resave|set (scripts/ops/ai-task-ranks.ts 머리 주석)");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAiTaskRanks(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
