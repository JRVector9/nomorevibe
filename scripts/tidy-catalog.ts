/**
 * 공개 목록 정리 — 문장이 된 이름과 키워드 규칙 시절의 기타를 지금 기준으로 다시 본다.
 *
 * 세 단계로 나눈다. 분류는 AI 를 부르므로 한 번만 돌리고, 사람이 본 목록 그대로 적용한다.
 *
 *   tsx --env-file=.env.local scripts/tidy-catalog.ts --out=tidy.json          (계획만 세워 파일로 남긴다)
 *   tsx --env-file=.env.local scripts/tidy-catalog.ts --apply=tidy.json        (그 파일대로 바꾼다)
 *   tsx --env-file=.env.local scripts/tidy-catalog.ts --revert=tidy.json       (그 파일대로 되돌린다)
 *
 * --names-only 는 AI 없이 이름만 본다. --limit=N 은 기타 N개만 분류해 본다.
 * CONNECT_AGENT_URL 이 있으면 발행과 같은 연결 서비스로, 없으면 이 기계의 Codex CLI 로 분류한다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { agentRequest } from "@/lib/operations/agent-client";
import { classifyCategories, MODELS } from "@/lib/crawl/classify";
import { getSettings } from "@/lib/crawl/settings";
import { applyChanges, planCategoryChanges, planNameChanges, reverse, type ClassifyBatch, type TidyChange } from "@/lib/crawl/tidy-catalog";
import type { Category } from "@/lib/domain/products/schema";

type Plan = { createdAt: string; names: TidyChange[]; categories: TidyChange[] };

function show(label: string, changes: TidyChange[]) {
  console.log(`\n${label} ${changes.length}건`);
  for (const change of changes.slice(0, 25)) console.log(`  ${(change.label ?? change.before).slice(0, 60).padEnd(60)} → ${change.after}`);
  if (changes.length > 25) console.log(`  … ${changes.length - 25}건 더`);
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, apply: { type: "string" }, revert: { type: "string" },
    "names-only": { type: "boolean", default: false }, limit: { type: "string" }, concurrency: { type: "string", default: "1" },
  } });

  const file = values.apply ?? values.revert;
  if (file) {
    const plan: Plan = JSON.parse(readFileSync(file, "utf8"));
    const changes = [...plan.names, ...plan.categories];
    const result = await applyChanges(values.revert ? reverse(changes) : changes);
    console.log(`${values.revert ? "되돌림" : "적용"} ${result.applied}건 · 그 사이 바뀌어 건너뜀 ${result.skipped}건`);
    return;
  }

  const names = await planNameChanges();
  show("이름", names);

  let categories: TidyChange[] = [];
  if (!values["names-only"]) {
    const { classify: { definitions } } = await getSettings();
    // 발행 잡의 시간 제한(8·12초)은 한 틱에 맞춘 값이다. 여기서는 기다린다 — 10개 묶음이 13초쯤 걸린다
    const models = MODELS.map((model) => ({ ...model, timeoutMs: 60_000 }));
    let unanswered = 0;
    const classify: ClassifyBatch = async (inputs) => {
      const result = process.env.CONNECT_AGENT_URL
        ? (await agentRequest<{ categories: (Category | null)[] }>("classify", { inputs, definitions })).categories
        : await classifyCategories(inputs, undefined, models, undefined, definitions);
      unanswered += result.filter((category) => category === null).length;
      return result;
    };
    categories = await planCategoryChanges(classify, {
      limit: values.limit ? Number(values.limit) : undefined,
      names: new Map(names.map((change) => [change.slug, change.after])),
      concurrency: Number(values.concurrency),
      onBatch: (done, total) => process.stderr.write(`\r기타 분류 ${done}/${total}`),
    });
    process.stderr.write("\n");
    show("기타 → 분류", categories);
    // 답을 못 받은 것은 기타로 남는다 — 많으면 모델 연결을 확인하고 다시 돌린다
    if (unanswered > 0) console.log(`  분류기가 답하지 못한 것 ${unanswered}건 — 기타로 둡니다`);
    const counts = new Map<string, number>();
    for (const change of categories) counts.set(change.after, (counts.get(change.after) ?? 0) + 1);
    console.log(`  ${[...counts].sort((a, b) => b[1] - a[1]).map(([category, n]) => `${category} ${n}`).join(" · ")}`);
  }

  if (values.out) {
    writeFileSync(values.out, JSON.stringify({ createdAt: new Date().toISOString(), names, categories } satisfies Plan, null, 1));
    console.log(`\n${values.out} 에 남겼습니다. 검토한 뒤 --apply=${values.out} 로 적용합니다.`);
  } else {
    console.log("\n--out=파일 을 붙이면 계획을 남깁니다. 지금은 보여주기만 했습니다.");
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
