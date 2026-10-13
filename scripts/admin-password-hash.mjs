import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Keep the password out of arguments, environment variables, shell history and output.
let password;
if (process.stdin.isTTY) {
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write("관리자 비밀번호 (12자 이상): ");
  try { password = await input.question(""); }
  finally { input.close(); process.stderr.write("\n"); }
} else {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1026) throw new Error("비밀번호는 1024 bytes 이하여야 합니다");
    chunks.push(chunk);
  }
  password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
if (password.length < 12 || Buffer.byteLength(password) > 1024 || /[\r\n]/.test(password)) {
  throw new Error("비밀번호는 줄바꿈 없이 12자 이상·1024 bytes 이하로 입력하세요");
}
const salt = randomBytes(16);
const key = scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
process.stdout.write(`scrypt$131072$8$1$${salt.toString("hex")}$${key.toString("hex")}\n`);
