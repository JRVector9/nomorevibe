/**
 * 빈 화면 본문 규칙(rules.ts stubTextHits)과 남의 사이트 8곳을 1차 AI 웹 심사 기록에 다시 걸어 잰다.
 *
 * 입력은 읽기 전용으로 뽑은 JSON Lines(한 줄에 1차 AI 심사 하나 — id·decision·mode·name·url·text). 2026-10-29 근거는
 * main-agent 보고 `nomorevibe-rule-gap-20261029/rows.jsonl`(10/22~10/29, 웹 심사 11,486건)이다. DB·네트워크는 쓰지 않는다.
 *
 *   npx tsx scripts/measure-stub-text-rules.ts <rows.jsonl> [--check]
 *
 * 규칙별 칸은 그 규칙에 걸린 심사 수(겹치면 각 규칙에 다 센다), 합계는 하나라도 걸린 심사 수다. 일치율 = 걸린 것 중 AI 도 거부한 비율.
 * --check 는 2026-10-29 지시 수치(거부·승인·보류)와 다르면 종료 코드 1로 끝낸다.
 *
 * 한계: 기록에 저장소 이름이 따로 없어(name 은 제목) 저장소 이름 낱말 없이 잰다. 운영 규칙은 저장소 이름 낱말도 "아는 낱말"로 보므로
 * 제목만 규칙이 운영에서 조금 더 걸릴 수 있다.
 */
import { readFileSync } from "node:fs";
import { stubTextHits, isBlockedHost, type StubTextRuleId } from "../lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "../lib/crawl/settings-schema";

type Row = { id: number; decision: string; mode: string; name: string | null; url: string | null; text: string | null };
type Count = { reject: number; approve: number; needs_review: number };

const RULES: { id: StubTextRuleId | "all"; label: string; expected: Count }[] = [
  { id: "title_only", label: "1 제목만", expected: { reject: 1387, approve: 229, needs_review: 29 } },
  { id: "loading_only", label: "2 로딩만", expected: { reject: 38, approve: 1, needs_review: 0 } },
  { id: "javascript_shell", label: "3 JavaScript 껍데기", expected: { reject: 70, approve: 13, needs_review: 0 } },
  { id: "login_only", label: "4 로그인 화면만", expected: { reject: 80, approve: 16, needs_review: 1 } },
  { id: "coming_soon", label: "5 출시 예정·대기 명단", expected: { reject: 9, approve: 1, needs_review: 0 } },
  { id: "all", label: "1~5 합계", expected: { reject: 1582, approve: 260, needs_review: 30 } },
];
/** 2026-10-29에 코드 기본값으로 더한 남의 사이트. huggingface.co 는 넣지 않는다(비교용으로만 잰다) */
const ADDED_HOSTS = ["zenodo.org", "arxiv.org", "pkg.go.dev", "codeberg.org", "stackblitz.com", "codefloe.com", "zenn.dev", "xdaforums.com"];

function main() {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) throw new Error("usage: tsx scripts/measure-stub-text-rules.ts <rows.jsonl> [--check]");
  const check = flags.includes("--check");

  const defaults = DEFAULT_CRAWL_SETTINGS.judge.thirdPartyHosts;
  const missing = ADDED_HOSTS.filter((host) => !defaults.includes(host));
  if (missing.length) throw new Error(`thirdPartyHosts 기본값에 없음: ${missing.join(", ")}`);
  if (defaults.includes("huggingface.co")) throw new Error("thirdPartyHosts 기본값에 huggingface.co 가 들어 있다");

  const web = readFileSync(path, "utf8").split("\n")
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => JSON.parse(line) as Row)
    .filter((row) => row.mode === "website");

  const zero = (): Count => ({ reject: 0, approve: 0, needs_review: 0 });
  const counts = new Map<string, Count>(RULES.map((rule) => [rule.id, zero()]));
  const hosts = zero();
  const huggingface = zero();
  const add = (count: Count, decision: string) => {
    if (decision in count) count[decision as keyof Count] += 1;
  };

  for (const row of web) {
    const hits = stubTextHits({ repo: "", productUrl: row.url, title: row.name, textSample: row.text });
    for (const id of new Set(hits.map((hit) => hit.id))) add(counts.get(id)!, row.decision);
    if (hits.length) add(counts.get("all")!, row.decision);
    if (row.url && isBlockedHost(row.url, ADDED_HOSTS)) add(hosts, row.decision);
    if (row.url && isBlockedHost(row.url, ["huggingface.co"])) add(huggingface, row.decision);
  }

  const total = (count: Count) => count.reject + count.approve + count.needs_review;
  const agree = (count: Count) => total(count) ? `${(100 * count.reject / total(count)).toFixed(1)}%` : "—";
  const cell = (count: Count) => `${count.reject.toLocaleString("en-US")}/${count.approve.toLocaleString("en-US")}/${count.needs_review.toLocaleString("en-US")} · ${agree(count)}`;
  const same = (a: Count, b: Count) => a.reject === b.reject && a.approve === b.approve && a.needs_review === b.needs_review;

  const lines = [
    `웹 심사 ${web.length.toLocaleString("en-US")}건 (거부 ${web.filter((r) => r.decision === "reject").length.toLocaleString("en-US")} · 승인 ${web.filter((r) => r.decision === "approve").length.toLocaleString("en-US")})`,
    "",
    "| 규칙 | 지시 거부/승인/보류 · 일치 | 실측(구현 코드) | 같음 |",
    "| --- | --- | --- | --- |",
  ];
  let differs = 0;
  for (const rule of RULES) {
    const actual = counts.get(rule.id)!;
    const ok = same(actual, rule.expected);
    if (!ok) differs += 1;
    lines.push(`| ${rule.label} | ${cell(rule.expected)} | ${cell(actual)} | ${ok ? "예" : "아니오"} |`);
  }
  const all = counts.get("all")!;
  lines.push("", `1~5 합계는 웹 심사의 ${(100 * total(all) / (web.length || 1)).toFixed(1)}%`);
  lines.push(`6 남의 사이트 8곳: ${cell(hosts)} · 비교용 huggingface.co(미포함): ${cell(huggingface)}`);
  process.stdout.write(lines.join("\n") + "\n");
  if (check && differs) {
    process.stderr.write(`지시 수치와 다른 규칙 ${differs}개\n`);
    process.exitCode = 1;
  }
}

main();
