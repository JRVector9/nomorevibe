import { eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsObservations } from "@/lib/db/schema";
import { storedSettingsVersion } from "@/lib/crawl/settings-version";
import { ROLE_LABELS } from "./contracts";
import { parseServiceObservationKey } from "./instance";

/**
 * 설정 적용 확인(2026-10-08 UX 감사 ADM-19) — 저장한 크롤 설정 판을 워커 역할마다 읽었는지.
 *
 * 워커는 잡이 getSettings 로 읽은 판을 heartbeat 에 싣고, 감시 프로세스가 그것을 service:<역할> 관측에 남긴다
 * (scripts/worker.ts·worker-supervisor.ts). 여기서는 그 관측을 저장된 판과 견준다.
 *
 * 설정을 자주 읽는 역할만 본다 — crawler·reviewer·publisher·text 는 1~5분마다 설정을 읽는 잡이 있다.
 * maintenance 는 한 시간에 한 번(news-refresh)만 읽어 10분 기준으로는 늘 늦어 보이고, scheduler 는 잡을 돌리지 않는다.
 */
export const SETTINGS_ROLES = ["crawler", "reviewer", "publisher", "text"] as const;
export type SettingsRole = (typeof SETTINGS_ROLES)[number];

/** 저장하고 이만큼 지나도 옛 판이면 조치할 일로 올린다 */
export const SETTINGS_LAG_SECONDS = 10 * 60;
/** 감시 프로세스는 15초마다 관측을 남긴다 — 1분 넘게 없으면 그 역할은 지금 일하지 않는다 */
const ACTIVE_SECONDS = 60;

/** applied 같은 판 · waiting 옛 판 · unknown 판을 싣지 않는 옛 워커 · inactive 지금 일하는 프로세스가 없음 */
export type RoleApplyState = "applied" | "waiting" | "unknown" | "inactive";
export type RoleSettingsApply = {
  role: SettingsRole;
  label: string;
  reportedVersion: string | null;
  /** 그 역할이 판을 읽은 시각(epoch ms, 워커 시계) */
  observedAt: number | null;
  state: RoleApplyState;
  /** 저장한 지 10분이 지나도 옛 판 */
  lagging: boolean;
};
/** 운영센터 조치할 일 한 칸에 그대로 옮길 수 있는 모양 */
export type SettingsApplyAttention = { key: "settings-apply"; tone: "hold"; count: number; title: string; detail: string; href: string };
export type SettingsApply = {
  savedVersion: string;
  roles: RoleSettingsApply[];
  /** 모든 역할이 저장된 판으로 돈다 */
  allApplied: boolean;
  attention: SettingsApplyAttention | null;
};

export type ApplyObservation = { key: string; value: Record<string, unknown>; ageSeconds: number };

/** 관측과 저장된 판을 견준다 — DB 없이 시험할 수 있게 나눈다 */
export function settingsApplyStatus(input: {
  savedVersion: string;
  /** 마지막 저장 뒤 지난 초. 저장한 적이 없으면 null(기본값으로 돈다 — 늦을 것이 없다) */
  savedAgeSeconds: number | null;
  observations: readonly ApplyObservation[];
}): SettingsApply {
  const instances = input.observations.flatMap((row) => {
    const parsed = parseServiceObservationKey(row.key);
    return parsed ? [{ ...row, role: parsed.role }] : [];
  });
  const roles = SETTINGS_ROLES.map((role): RoleSettingsApply => {
    const label = ROLE_LABELS[role] ?? role;
    // 주·예비가 바뀌면 옛 인스턴스의 관측이 남는다 — 가장 최근 것이 지금 일하는 쪽이다
    const latest = instances.filter((row) => row.role === role).sort((a, b) => a.ageSeconds - b.ageSeconds)[0];
    const status = latest?.value.status;
    if (!latest || latest.ageSeconds > ACTIVE_SECONDS || status === "stopping" || status === "failed") {
      return { role, label, reportedVersion: null, observedAt: null, state: "inactive", lagging: false };
    }
    const version = typeof latest.value.settingsVersion === "string" ? latest.value.settingsVersion : null;
    const readAt = typeof latest.value.settingsReadAt === "number" ? latest.value.settingsReadAt : null;
    const state = version === null ? "unknown" : version === input.savedVersion ? "applied" : "waiting";
    const lagging = state === "waiting" && input.savedAgeSeconds !== null && input.savedAgeSeconds > SETTINGS_LAG_SECONDS;
    return { role, label, reportedVersion: version, observedAt: readAt, state, lagging };
  });
  const lagging = roles.filter((role) => role.lagging);
  const minutes = Math.floor((input.savedAgeSeconds ?? 0) / 60);
  return {
    savedVersion: input.savedVersion,
    roles,
    allApplied: roles.every((role) => role.state === "applied"),
    attention: lagging.length === 0 ? null : {
      key: "settings-apply", tone: "hold", count: lagging.length,
      title: "저장한 설정이 워커에 닿지 않음",
      detail: `${lagging.map((role) => role.label).join("·")} 이(가) 설정을 저장하고 ${minutes}분이 지나도 옛 판으로 돕니다. `
        + "설정을 읽는 잡이 돌지 못하고 있는지 운영센터의 역할·작업 표에서 확인하세요.",
      href: "/admin#apply",
    },
  };
}

/** 저장된 판과 역할별 관측을 읽어 견준다. 경과는 DB 시계로 잰다(시각 열은 시간대 없는 UTC 벽시계다) */
export async function readSettingsApply(): Promise<SettingsApply> {
  const [saved, observations] = await Promise.all([
    db.select({
      values: crawlSettings.values,
      ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${crawlSettings.updatedAt}))::double precision`,
    }).from(crawlSettings).where(eq(crawlSettings.id, 1)),
    db.select({
      key: operationsObservations.key, value: operationsObservations.value,
      ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${operationsObservations.observedAt}))::double precision`,
    }).from(operationsObservations)
      .where(or(like(operationsObservations.key, "service:%"), inArray(operationsObservations.key, [...SETTINGS_ROLES]))),
  ]);
  const row = saved[0];
  return settingsApplyStatus({
    // 행이 없으면 워커도 빈 값(기본값)을 읽는다 — getSettings 와 같은 판이 나온다
    savedVersion: storedSettingsVersion(row?.values),
    savedAgeSeconds: row ? Number(row.ageSeconds) : null,
    observations: observations.map((item) => ({ key: item.key, value: item.value, ageSeconds: Number(item.ageSeconds) })),
  });
}
