// 05c-5 가짜 CLI — 소개 검수·Grok 세션 점검의 답 모양만 더한다. 그 밖의 모드(ok·hang·grandchild-hold …)는 fake.mjs 가 그대로 맡는다.
// 실제 claude/grok 은 부르지 않는다. FAKE_CLI_RECORD 디렉터리에 argv·stdin·pid 를 남긴다(fake.mjs 와 같은 모양).
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const mode = process.env.FAKE_CLI_MODE ?? "ok";
const realCliOnPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  .some(dir => ["claude", "grok", "codex"].some(name => existsSync(path.join(dir, name))));
function record(extra = {}) {
  const dir = process.env.FAKE_CLI_RECORD;
  if (!dir) return;
  writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ mode, pid: process.pid, argv: process.argv.slice(2),
    env: { PATH: process.env.PATH ?? null, CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
      CLAUDECODE: process.env.CLAUDECODE ?? null, NO_COLOR: process.env.NO_COLOR ?? null, RUST_LOG: process.env.RUST_LOG ?? null },
    realCliOnPath, ...extra }));
}
const readStdin = () => new Promise(resolve => {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
});
const write = text => new Promise(resolve => process.stdout.write(text, resolve));

if (mode === "intro-ok") {
  // 보낸 제품마다 "맞음" — checkIntros 가 그대로 읽는 Claude envelope
  const stdin = await readStdin();
  record({ stdin: stdin.toString("base64") });
  const body = stdin.toString("utf8").replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "");
  const results = JSON.parse(body).map(item => ({ slug: item.slug, verdict: "ok", problem: "", corrected: "" }));
  await write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { results },
    usage: { input_tokens: 400, output_tokens: 60 }, total_cost_usd: 0.004 }));
} else if (mode === "grok-ok") {
  // stdin 은 열리지 않는다(Grok 은 --prompt-file·-p). 세션 점검이 찾는 "OK" 와 실제 모델 이름
  record();
  await write(`log line\n${JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } })}`);
} else await import("./fake.mjs");
