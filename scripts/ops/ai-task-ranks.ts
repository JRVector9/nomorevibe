/**
 * 「작업 ↔ 모델」 순위를 배포 창 안에서(capacity DRAINING) 화면 없이 다룬다 — 화면(/admin/models/tasks)과 같은 함수를 부른다.
 *
 *   node --import tsx scripts/ops/ai-task-ranks.ts status [--json]
 *   node --import tsx scripts/ops/ai-task-ranks.ts preview [--json]                 가져오기 계획(쓰지 않는다, 키는 이름만)
 *   node --import tsx scripts/ops/ai-task-ranks.ts apply --hash=<64hex> --operator=<이름>  계획 hash 가 같을 때만 적용
 *   node --import tsx scripts/ops/ai-task-ranks.ts resave --operator=<이름> [--task=a,b]  저장된 순위를 그대로 다시 저장(빠진 계약·정책 route·장비를 만든다)
 *
 * DATABASE_URL 은 앱과 같은 것을 쓴다(웹·워커가 읽는 env 로 「지금 실제로 쓰는 모델」을 판정하므로 운영 컨테이너 안에서 돌린다).
 */
import { applyAiTaskImport, previewAiTaskImport, readAiTasksAdminView, saveAiTaskRanks } from "@/lib/operations/admin-ai-tasks-repository";

type Args = { command: string; json: boolean; hash: string | null; operator: string | null; tasks: string[] | null };

export function parseAiTaskRanksArgs(argv: readonly string[]): Args {
  const [command = "", ...rest] = argv;
  const value = (name: string) => rest.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const tasks = value("task");
  return { command, json: rest.includes("--json"), hash: value("hash"), operator: value("operator"), tasks: tasks ? tasks.split(",").map(task => task.trim()).filter(Boolean) : null };
}

async function main(argv: readonly string[]): Promise<number> {
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
    return preview.error ? 1 : 0;
  }
  if (args.command === "apply") {
    if (!args.hash || !args.operator) { console.error("usage: apply --hash=<64hex> --operator=<이름>"); return 2; }
    const result = await applyAiTaskImport(args.hash, args.operator);
    console.log(JSON.stringify(result));
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
  console.error("usage: status|preview|apply|resave (scripts/ops/ai-task-ranks.ts 머리 주석)");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
