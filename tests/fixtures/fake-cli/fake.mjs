// 가짜 모델 CLI — 실제 claude/grok/codex 를 부르지 않고 프로세스가 끝나는 모양만 재현한다.
// FAKE_CLI_MODE 로 동작을 고르고, FAKE_CLI_RECORD 디렉터리에 argv·stdin·pid 를 남긴다(spawn 여부·byte 동일성 확인용).
import { spawn } from "node:child_process";
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
      CLAUDECODE: process.env.CLAUDECODE ?? null }, realCliOnPath, ...extra }));
}
const readStdin = () => new Promise(resolve => {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
  process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
});
const envelope = (change = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "",
  structured_output: { decision: "approve", reason: "가짜 CLI 답 — 모델을 부르지 않았다", evidenceIds: ["product"], confidence: 0.9 },
  usage: { input_tokens: 120, output_tokens: 30 }, total_cost_usd: 0.0021, ...change });
const write = (stream, text) => new Promise(resolve => stream.write(text, resolve));
const hang = () => { process.stdin.resume(); setInterval(() => {}, 1000); };
const grandchild = options => spawn(process.execPath, ["-e", options.code], options.spawn);

switch (mode) {
  case "ok": { const stdin = await readStdin(); record({ stdin: stdin.toString("base64") }); await write(process.stdout, envelope()); break; }
  case "usage-over": { await readStdin(); record(); await write(process.stdout, envelope({ usage: { input_tokens: 900_000_000, output_tokens: 30 } })); break; }
  case "fail": {
    await readStdin(); record();
    await write(process.stdout, envelope({ is_error: true, result: "API Error: 429 rate_limit_error", structured_output: undefined }));
    process.exitCode = 1; break;
  }
  case "signal": { await readStdin(); record(); await write(process.stdout, "partial"); process.kill(process.pid, "SIGTERM"); break; }
  case "hang": { record(); hang(); break; }
  case "flood": { record(); hang(); await write(process.stdout, "x".repeat(80_000)); break; }
  case "stderr-only": { await readStdin(); record(); await write(process.stderr, "fatal: fake failure\n"); process.exitCode = 2; break; }
  case "empty": { await readStdin(); record(); break; }
  case "grandchild-hold": {
    // 손자가 stdout·stderr pipe 를 물려받아 쥐고 SIGTERM 도 무시한다 — 부모가 끝나도 close 가 오지 않는다.
    const child = grandchild({ code: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", spawn: { stdio: ["ignore", "inherit", "inherit"] } });
    child.unref(); await readStdin(); record({ grandchild: child.pid }); await write(process.stdout, envelope()); process.exit(0);
    break;
  }
  case "setsid-grandchild": {
    // detached 는 POSIX 에서 setsid — 새 세션·그룹으로 빠지고 stdio 도 닫는다. exit+close 로는 보이지 않는 알려진 한계다.
    const child = grandchild({ code: "setInterval(()=>{},1000)", spawn: { stdio: "ignore", detached: true } });
    child.unref(); await readStdin(); record({ grandchild: child.pid }); await write(process.stdout, envelope()); process.exit(0);
    break;
  }
  case "late-close": {
    // 부모는 곧바로 끝나고, pipe 를 물려받은 손자가 300ms 뒤에 마저 쓰고 끝난다 — close 가 exit 보다 늦게 온다.
    const child = grandchild({ code: "setTimeout(()=>process.stdout.write('late'),300)", spawn: { stdio: ["ignore", "inherit", "inherit"] } });
    child.unref(); await readStdin(); record({ grandchild: child.pid }); await write(process.stdout, "early"); process.exit(0);
    break;
  }
  default: process.stderr.write(`unknown FAKE_CLI_MODE ${mode}\n`); process.exitCode = 64;
}
