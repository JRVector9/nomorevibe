import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { CONTRACT_READER_FIELD, CONTRACT_READER_REQUIRED } from "./contract-reader-mark";
import { parseServiceObservationKey } from "./instance";

/**
 * 새 모양 계약(openai-chat-total-bound-v1)의 읽기 관문(2026-11-21 abcllm 이름표 정리 2단계). 옛 판 프로세스는 모르는 protocol 을 「계약 없음」으로
 * 읽어 그 경로를 닫고, 심사 두 경로에서는 순위 묶기가 심사자 identity 를 잃는다(PR #1012 리뷰). 그래서 새 모양을 저장하거나 abcllm 계약을 전환하기
 * 전에 「계약을 읽는 모든 프로세스가 새 판」인지 DB 에 남은 흔적으로 본다.
 *
 * 무엇을 보나(최근 CONTRACT_READER_WINDOW_MS 안):
 * 1. 서비스 관측(operations_observations 의 service:<역할>:<인스턴스> 와 옛 역할 키) — 웹·scheduler·다섯 역할·consumer(ai1·ai2·agent-scan·uptime·
 *    capacity-supervisor·github-ko-discovery, Oracle 포함)·connect-agent 가 5~15초마다 쓴다(observeService). 이 판 이상은 계약 읽기 세대 표지
 *    (contract-reader-mark.ts)를 싣는다. 표지가 없거나 낮으면 거절한다.
 * 2. 살아 있는 역할 lease(role_leases.owner_release) 와 최근 역할 후보(job_batch_candidates.release) — 관측을 쓰지 못한 프로세스라도 lease·후보는
 *    남는다. 그 release 가 표지를 실은 관측의 release 중 하나여야 한다(같은 release = 같은 코드).
 * 관측이 하나도 없으면 아무것도 증명하지 못하므로 거절한다.
 *
 * 보지 못하는 것(관문이 통과해도 사람이 확인한다 — 운영 절차 문서에 적는다):
 * - 읽기 전용 monitor(DB 에 쓰지 않는다 — text 진행 판정이 계약을 읽는다). 옛 판이면 경로를 「계약 없음」으로 보고 경보만 낸다.
 * - 운영자가 옛 checkout·옛 이미지에서 한 번 돌리는 CLI(scripts/*) — 관측을 남기지 않는다.
 * - 멈춰 있다가 다시 뜰 앱·Swarm 이 옛 이미지로 되돌릴 앱(지금 돌지 않으면 흔적이 창 밖으로 나간다) — 전환 뒤에는 이 판 아래로 되돌리지 않는다.
 * - 관측 쓰기가 막힌 프로세스(DR fenced 웹은 관측을 쓰지 않는다)가 lease·후보도 남기지 않는 경우.
 * - 창(10분)보다 오래 관측을 못 쓴 채 살아 있는 프로세스.
 */
export const CONTRACT_READER_WINDOW_MS = 10 * 60_000;

export type ContractReaderProcess = Readonly<{ source: "observation" | "lease" | "candidate"; name: string; release: string | null;
  /** no_marker: 표지 없는 옛 판 · old_marker: 낮은 세대 · release_unproven: 표지를 실은 관측에 없는 release · release_missing: release 를 모름 */
  reason: "no_marker" | "old_marker" | "release_unproven" | "release_missing" }>;
export type ContractReaderGate = Readonly<{
  ok: boolean;
  /** 거절의 대표 까닭(ok 이면 null): stale_processes · no_observations · read_failed */
  reason: "stale_processes" | "no_observations" | "read_failed" | null;
  required: number;
  checked: Readonly<{ observations: number; leases: number; candidates: number }>;
  /** 표지를 실은 관측의 release(앞 12자) */
  releases: readonly string[];
  stale: readonly ContractReaderProcess[];
}>;
export type ContractReaderInput = Readonly<{
  observations: readonly Readonly<{ key: string; value: Record<string, unknown> }>[];
  leases: readonly Readonly<{ role: string; ownerInstanceId: string | null; ownerRelease: string | null }>[];
  candidates: readonly Readonly<{ role: string; instanceId: string; host: string; release: string }>[];
}>;

const releaseOf = (value: unknown): string | null => typeof value === "string" && value.trim() && value !== "unknown" ? value : null;
const short = (release: string | null) => release ? release.slice(0, 12) : null;

/** 순수 판정(시험·화면 문장이 같은 규칙을 쓴다). 들어온 행은 이미 창 안의 것이다. */
export function evaluateContractReaderGate(input: ContractReaderInput, required = CONTRACT_READER_REQUIRED): ContractReaderGate {
  // 옛 역할 키(인스턴스 id 없는 프로세스)도 버리지 않는다 — 같은 역할의 새 키가 있어도 그 프로세스는 따로 돈다
  const instances = input.observations.flatMap(row => {
    const parsed = parseServiceObservationKey(row.key);
    return parsed ? [{ ...row, ...parsed }] : [];
  });
  const stale: ContractReaderProcess[] = [], proven = new Set<string>();
  for (const row of instances) {
    const release = releaseOf(row.value.release), mark = row.value[CONTRACT_READER_FIELD];
    const name = row.instanceId === "legacy" ? row.role : `${row.role}:${row.instanceId}`;
    if (typeof mark !== "number" || !Number.isSafeInteger(mark)) stale.push({ source: "observation", name, release: short(release), reason: "no_marker" });
    else if (mark < required) stale.push({ source: "observation", name, release: short(release), reason: "old_marker" });
    else if (!release) stale.push({ source: "observation", name, release: null, reason: "release_missing" });
    else proven.add(release);
  }
  const unproven = (source: ContractReaderProcess["source"], name: string, value: string | null) => {
    const release = releaseOf(value);
    if (!release) stale.push({ source, name, release: null, reason: "release_missing" });
    else if (!proven.has(release)) stale.push({ source, name, release: short(release), reason: "release_unproven" });
  };
  for (const lease of input.leases) unproven("lease", `${lease.role}:${lease.ownerInstanceId ?? "?"}`, lease.ownerRelease);
  for (const candidate of input.candidates) unproven("candidate", `${candidate.role}:${candidate.host}:${candidate.instanceId}`, candidate.release);
  const reason = !instances.length ? "no_observations" as const : stale.length ? "stale_processes" as const : null;
  return Object.freeze({ ok: reason === null, reason, required,
    checked: Object.freeze({ observations: instances.length, leases: input.leases.length, candidates: input.candidates.length }),
    releases: Object.freeze([...proven].map(release => release.slice(0, 12)).sort()), stale: Object.freeze(stale) });
}

type Reader = Pick<typeof db, "execute">;
/**
 * 관문을 DB 에서 읽는다(쓰지 않는다). 호출자의 TX 안에서 부르면 그 TX 로 읽는다. 읽지 못하면 닫힌다(read_failed).
 * 관측 시각(operations_observations.observed_at)은 시간대 없는 칸에 UTC 벽시계로 쓰이므로 UTC 로 견준다.
 */
export async function readContractReaderGate(reader: Reader = db, required = CONTRACT_READER_REQUIRED): Promise<ContractReaderGate> {
  try {
    const seconds = CONTRACT_READER_WINDOW_MS / 1000;
    const observations = Array.from(await reader.execute<{ key: string; value: Record<string, unknown> }>(sql`
      SELECT key, value FROM operations_observations
      WHERE observed_at > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${seconds}) AND (key LIKE 'service:%' OR key NOT LIKE '%:%')`));
    const leases = Array.from(await reader.execute<{ role: string; owner_instance_id: string | null; owner_release: string | null }>(sql`
      SELECT role, owner_instance_id, owner_release FROM role_leases WHERE owner_instance_id IS NOT NULL AND lease_until > now()`));
    const candidates = Array.from(await reader.execute<{ role: string; instance_id: string; host: string; release: string }>(sql`
      SELECT role, instance_id, host, release FROM job_batch_candidates WHERE observed_at > clock_timestamp() - make_interval(secs => ${seconds})`));
    return evaluateContractReaderGate({ observations: observations.map(row => ({ key: row.key, value: row.value ?? {} })),
      leases: leases.map(row => ({ role: row.role, ownerInstanceId: row.owner_instance_id, ownerRelease: row.owner_release })),
      candidates: candidates.map(row => ({ role: row.role, instanceId: row.instance_id, host: row.host, release: row.release })) }, required);
  } catch {
    return Object.freeze({ ok: false, reason: "read_failed" as const, required, checked: Object.freeze({ observations: 0, leases: 0, candidates: 0 }),
      releases: Object.freeze([]), stale: Object.freeze([]) });
  }
}

const REASON_TEXT: Record<ContractReaderProcess["reason"], string> = {
  no_marker: "옛 판(계약 읽기 표지 없음)", old_marker: "낮은 계약 읽기 세대", release_unproven: "새 판 관측에 없는 release", release_missing: "release 모름",
};
/** 화면·스크립트 한 줄(한국어) — 열 개까지 이름을 적는다. */
export function contractReaderGateText(gate: ContractReaderGate): string {
  if (gate.ok) return `모든 프로세스가 새 판입니다(관측 ${gate.checked.observations} · lease ${gate.checked.leases} · 후보 ${gate.checked.candidates}, release ${gate.releases.join("·")}).`;
  if (gate.reason === "read_failed") return "프로세스 판을 읽지 못했습니다 — 새 모양 계약을 만들지 않습니다.";
  if (gate.reason === "no_observations") return `최근 ${CONTRACT_READER_WINDOW_MS / 60_000}분 안의 서비스 관측이 없어 모든 프로세스가 새 판인지 모릅니다.`;
  const listed = gate.stale.slice(0, 10).map(row => `${row.name}(${REASON_TEXT[row.reason]}${row.release ? ` ${row.release}` : ""})`);
  return `옛 판 프로세스 ${gate.stale.length}개: ${listed.join(", ")}${gate.stale.length > 10 ? " …" : ""} — 모두 새 판으로 배포된 뒤 ${CONTRACT_READER_WINDOW_MS / 60_000}분이 지나면 열립니다.`;
}
