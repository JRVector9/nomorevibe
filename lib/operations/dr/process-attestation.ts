import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * PR15f: 이 프로세스가 놓인 커널 boot 와 PID namespace. DB 를 읽지 않는 가벼운 모듈이다.
 * 옛 boot 와 후속 boot 의 두 값이 모두 같으면 후속 boot 의 kill(-pgid,0) 은 옛 그룹과 같은 PID 공간을 본다 — 같은 live namespace 이거나,
 * inode 가 같아도 옛 namespace 가 이미 해제돼 번호가 재사용된 경우다(namespace 는 그 안의 task 가 모두 회수돼야 해제되므로 그때 옛 그룹은 이미 없다).
 * 다른 커널·다른 namespace 에서 본 ESRCH 는 그 그룹에 대한 사실이 아니다. 시간·heartbeat 는 쓰지 않는다.
 * 가정: /proc 는 커널이 직접 제공한다(gVisor 같은 사용자 공간 커널·CRIU 이전 제외), 같은 boot_id 커널이 둘 뜨는 VM 메모리 복제는 없다.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pidNamespace = z.number().int().min(1).max(4294967295);
export const processAttestationSchema = z.object({ version: z.literal(1), kernelBootId: z.string().regex(UUID), pidNamespace }).strict();
export type ProcessAttestation = Readonly<z.infer<typeof processAttestationSchema>>;
/** 후속 boot 가 남긴 group_exited 의 detail(0101 CHECK 와 같은 모양). observerBootId ≠ 옛 owner boot 는 DB 가 본다. */
export const successorExitDetailSchema = z.object({ version: z.literal(1), observerBootId: z.string().regex(UUID), kernelBootId: z.string().regex(UUID),
  pidNamespace }).strict();
export const SUCCESSOR_EXIT_METHOD = "pgid_esrch_by_successor";

/** procfs 에서 읽는다. 읽을 수 없거나 모양이 다르면 null — 그 boot 는 후속 관측의 대상도 관측자도 되지 않는다(근거 없음, 기존과 같음). */
export function readProcessAttestation(procRoot = "/proc"): ProcessAttestation | null {
  try {
    const kernelBootId = readFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8").replace(/\n$/, "");
    const link = /^pid:\[([1-9][0-9]{0,9})\]$/.exec(readlinkSync(path.join(procRoot, "self/ns/pid")));
    const parsed = processAttestationSchema.safeParse({ version: 1, kernelBootId, pidNamespace: link ? Number(link[1]) : null });
    return parsed.success ? Object.freeze(parsed.data) : null;
  } catch { return null; }
}

/** PROCESS_GROUP_SUCCESSOR_PROBE: 미설정/`0`=꺼짐, `1`=켜짐. 다른 값은 설정 오류다. */
export function successorProbeEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.PROCESS_GROUP_SUCCESSOR_PROBE;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("invalid_process_group_successor_probe");
}

export function sameProcessNamespace(a: ProcessAttestation, b: ProcessAttestation): boolean {
  return a.kernelBootId === b.kernelBootId && a.pidNamespace === b.pidNamespace;
}
/** 후속 관측 detail 이 옛 owner 가 남긴 attestation 과 같은 커널·namespace 에서 나왔는가. */
export function successorExitMatches(detail: unknown, owner: ProcessAttestation): boolean {
  const parsed = successorExitDetailSchema.safeParse(detail);
  return parsed.success && sameProcessNamespace({ version: 1, kernelBootId: parsed.data.kernelBootId, pidNamespace: parsed.data.pidNamespace }, owner);
}
