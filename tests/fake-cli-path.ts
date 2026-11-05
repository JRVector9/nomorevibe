import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";

/**
 * 1차·2차 심사와 Grok 로그인 유지는 CLI 를 PATH 의 도구 이름(claude·grok)으로 띄운다(PR C1 — env 경로 CLAUDE_CLI·GROK_CLI 를 읽지 않는다).
 * 시험은 가짜 CLI(절대경로 sh 래퍼)를 그 이름의 심볼릭 링크로 둔 디렉터리를 만들어 자식 PATH 로 쓴다 — 실제 claude/grok 은 띄우지 않는다.
 * 같은 디렉터리를 다시 부르면 안의 링크를 지우고 새로 놓는다(시험마다 래퍼를 바꿔 끼울 때).
 */
export type FakeToolName = "claude" | "grok" | "codex" | "opencode";
export async function fakeToolDir(dir: string, tools: Partial<Record<FakeToolName, string>>): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true });
  for (const [name, target] of Object.entries(tools)) if (target) await symlink(target, path.join(dir, name));
  return dir;
}

/** CLI 연결 하나를 가리키는 「작업 ↔ 모델」 순위 한 줄(시험용). 기본: 1칸 1순위 · grok CLI 연결 · 켜짐. */
export function cliRankRow(task: string, model: string, options: Partial<{ slot: number; rank: number; cliTool: string; enabled: boolean;
  connectionEnabled: boolean; connectionId: string; label: string }> = {}): AiTaskModelSnapshotRow {
  const rank = options.rank ?? 1;
  return Object.freeze({ task, slot: options.slot ?? 1, rank, model, enabled: options.enabled ?? true, options: Object.freeze({}),
    connection: Object.freeze({ id: options.connectionId ?? `0c0d0e0f-0000-4000-8000-${String(rank).padStart(12, "0")}`,
      label: options.label ?? `test-${options.cliTool ?? "grok"}-cli`, kind: "cli" as const, baseUrl: null, cliTool: options.cliTool ?? "grok",
      deviceId: "test-device", enabled: options.connectionEnabled ?? true, models: null, contextTokens: null, apiKey: null, keyUnreadable: false }) });
}
/** 순위 스냅숏 고정(null = 풀기). */
export const pinTaskRanks = (rows: readonly AiTaskModelSnapshotRow[] | null) => setAiTaskModelsForTest(rows);
