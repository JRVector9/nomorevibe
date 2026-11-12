import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import type { ModelConsoleInput, ModelDeviceState } from "@/lib/operations/model-console";
import type { ModelConsoleRead } from "@/lib/operations/model-console-read";
import { buildModelConsole } from "@/lib/operations/model-console";
import probe from "./console-home-probe.json";
import { splitLedgerRow } from "./console-home";

/**
 * 운영 콘솔 「모델」 시험의 고정 자료 — 홈(조각 1b)이 쓰는 2026-11-12 08:59 KST 운영 읽기(console-home-probe.json)를 그대로 쓰고,
 * 모델 화면이 더 읽는 칸만 같은 날 시안 재료(admin-final-20261112/probe.json)의 값으로 보강했다:
 * 연결의 컨텍스트 상한·추론 여유·목록 없는 서버의 모델 이름, supa 의 두 이름이 같은 root, 장비 행 한도·판·모델별 한도(m3-mlx), 장부의 미확정 수(supa 19).
 * 주소는 가짜 호스트(*.example)이고 키는 넣지 않았다.
 */
export const MODEL_PROBE_AT = probe.at;
const EXTRA: Readonly<Record<string, Partial<AiConnectionView>>> = {
  "conn-lg-exaone": { contextTokens: 524_288, reasoningTokenReserve: 12_800, manualModels: ["k-exaone_v2.5"], hasKey: true, models: [{ id: "k-exaone_v2.5", maxModelLen: null }],
    note: "비상업 용도 전용" },
  "conn-m1max": { contextTokens: 131_072, reasoningTokenReserve: 20_000, manualModels: ["Qwen3.8"], hasKey: true,
    models: [{ id: "mlx-community/Qwen3.8-27B-4bit", maxModelLen: null }] },
  "conn-gpu3090-qwen": { models: [{ id: "qwen3.8-flash-next", maxModelLen: 50_000 }] },
  "conn-m1-gemma": { contextTokens: 98_304, models: [{ id: "m1-gemma", maxModelLen: null }] },
  "conn-m3-deepseek": { models: [{ id: "deepseek-v4.1-flash-1017", maxModelLen: 262_144 }] },
  "conn-m3-gpt-oss": { contextTokens: 131_072, models: [{ id: "gpt-oss-120b", maxModelLen: null }] },
  "conn-supa-direct": { models: [{ id: "supa", maxModelLen: 131_072, root: "Inferact/Qwen3.8-27B-NVFP4" },
    { id: "Inferact/Qwen3.8-27B-NVFP4", maxModelLen: 131_072, root: "Inferact/Qwen3.8-27B-NVFP4" }] },
  "conn-claude-cli": { cliModels: ["sonnet"], cliVersion: "2.1.0 (Claude Code)" },
  "conn-m3-opencode": { cliModels: ["opencode-go/deepseek-v4.1-flash"] },
};
/** 장비 행(시안 재료 devices) — 한도·판·모델별 한도 */
const DEVICE_ROWS: Readonly<Record<string, { limitSlots: number; version: number; limits?: { model: string; maxSlots: number; engineMax: number | null }[] }>> = {
  Exaone: { limitSlots: 1, version: 1 }, "anthropic-cli": { limitSlots: 2, version: 4 }, "gpu3090-qwen": { limitSlots: 5, version: 5 },
  "m1-qwen": { limitSlots: 2, version: 4 }, m1max: { limitSlots: 2, version: 2 }, "m3-opencode-host": { limitSlots: 2, version: 2 },
  "openai-cli": { limitSlots: 4, version: 3 }, "supa-direct": { limitSlots: 3, version: 4 },
  "m3-mlx": { limitSlots: 3, version: 6, limits: [{ model: "deepseek-v4.1-flash-1017", maxSlots: 1, engineMax: 1 }, { model: "gpt-oss-120b", maxSlots: 2, engineMax: 4 }] },
};

export function modelFixtureConnections(): AiConnectionView[] {
  return structuredClone(probe.connections).map((row): AiConnectionView => {
    const extra = EXTRA[row.id] ?? {};
    const api = row.kind === "api";
    const host = api ? `${row.deviceId.toLowerCase()}.example` : row.cliTool === "opencode" ? "opencode-host.example" : null;
    return { id: row.id, label: row.label, kind: row.kind as "api" | "cli", baseUrl: host ? `https://${host}/v1` : null, host, hasKey: row.cliTool === "opencode",
      cliTool: row.cliTool as AiConnectionView["cliTool"], cliModels: [], models: api ? row.models.map(id => ({ id, maxModelLen: null })) : null,
      modelsReadAt: api ? "2026-11-11T22:00:00.000Z" : null, modelsError: null, deviceId: row.deviceId, capacitySlots: row.capacitySlots, contextTokens: null,
      enabled: row.enabled, version: 3, note: null, updatedBy: "jr", updatedAt: row.updatedAt, cliVersion: null, manualModels: [], allowedTasks: row.allowedTasks,
      reasoningTokenReserve: null, keySetAt: row.keySetAt, keyValidDays: row.keyValidDays, displayName: null, machine: null, ...extra };
  });
}

export function modelFixtureDevices(): ModelDeviceState[] {
  return structuredClone(probe.observation.devices).map(device => {
    const row = DEVICE_ROWS[device.deviceId];
    return { deviceId: device.deviceId, source: row ? "table" as const : null, limitSlots: row?.limitSlots ?? null, active: device.active, version: row?.version ?? null,
      models: [...new Set([...device.models.map(model => model.model), ...(row?.limits ?? []).map(limit => limit.model)])].map(model => {
        const limit = row?.limits?.find(entry => entry.model === model);
        return { model, active: device.models.find(entry => entry.model === model)?.active ?? 0, maxSlots: limit?.maxSlots ?? null, engineMax: limit?.engineMax ?? null };
      }) };
  });
}

export function modelFixtureInput(overrides: Partial<ModelConsoleInput> = {}): ModelConsoleInput {
  const copy = structuredClone(probe);
  return {
    now: copy.at, connections: modelFixtureConnections(), devices: modelFixtureDevices(),
    ranks: copy.ranks, pools: copy.pools,
    ledger: copy.ledger.map(row => ({ ...splitLedgerRow(row), indeterminate: row.groupId === "supa-direct" && row.routeId === "product-search-verify" ? 19 : 0 })),
    pausedJobs: copy.jobs.filter(job => job.paused).map(job => job.name),
    ...overrides,
  };
}

export function modelFixtureRead(overrides: Partial<ModelConsoleInput> = {}): ModelConsoleRead {
  const input = modelFixtureInput(overrides);
  return { view: buildModelConsole(input), devices: input.devices, secretBox: true, admission: { mode: "open", since: probe.observation.since } };
}
