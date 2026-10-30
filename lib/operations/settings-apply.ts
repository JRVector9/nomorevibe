import { eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlSettings, operationsObservations } from "@/lib/db/schema";
import { storedSettingsVersion } from "@/lib/crawl/settings-version";
import { ROLE_LABELS } from "./contracts";
import { isConsumerServiceInstance, parseServiceObservationKey } from "./instance";

/**
 * 설정 적용 확인(2026-10-08 UX 감사 ADM-19) — 저장한 판을 워커 역할마다 읽었는지.
 *
 * 워커는 잡이 읽은 판을 heartbeat 에 싣고, 감시 프로세스가 그것을 service:<역할> 관측에 남긴다(scripts/worker.ts·worker-supervisor.ts).
 * 여기서는 그 관측을 저장된 판과 견준다. 두 문서가 같은 길을 쓴다:
 * - 크롤 설정(crawl_settings): 관측 필드 settingsVersion/settingsReadAt. 설정을 자주 읽는 역할만 본다 — crawler·reviewer·publisher·text 는
 *   1~5분마다 설정을 읽는 잡이 있다. maintenance 는 한 시간에 한 번(news-refresh)만 읽어 10분 기준으로는 늘 늦어 보이고, scheduler 는 잡을 돌리지 않는다.
 * - 관리자 실시간 한도(runtime_settings, PR 1a): 관측 필드 runtimeSettingsVersion/runtimeSettingsReadAt/runtimeSettingsRegistryEnv.
 *   모든 역할 워커가 poll 마다 스냅샷을 고정하므로 maintenance 도 본다. registryEnv 가 true 인 역할은 MODEL_REGISTRY_CONFIG env 로 돌아
 *   경로 한도 저장이 닿지 않는다(번역·잡별 묶음·틱 예산은 닿는다) — 화면이 'env 등록부' 배지로 보인다.
 */
export const SETTINGS_ROLES = ["crawler", "reviewer", "publisher", "text"] as const;
export type SettingsRole = (typeof SETTINGS_ROLES)[number];
/** 실시간 한도는 모든 역할 워커가 poll 마다 읽는다 */
export const RUNTIME_SETTINGS_ROLES = ["crawler", "reviewer", "publisher", "text", "maintenance"] as const;
export type RuntimeSettingsRole = (typeof RUNTIME_SETTINGS_ROLES)[number];
export type ApplyRole = SettingsRole | RuntimeSettingsRole;

/** 저장하고 이만큼 지나도 옛 판이면 조치할 일로 올린다 */
export const SETTINGS_LAG_SECONDS = 10 * 60;
/** 감시 프로세스는 15초마다 관측을 남긴다 — 1분 넘게 없으면 그 역할은 지금 일하지 않는다 */
const ACTIVE_SECONDS = 60;

/** 어느 문서의 적용을 보는지 — service:<역할> 관측에서 읽을 필드 이름·보는 역할·조치할 일 글귀 */
export type ApplyKind = {
  key: "settings-apply" | "runtime-settings-apply";
  /** 관측(WorkerHealth) 의 필드 이름 */
  fields: { version: string; readAt: string; registryEnv?: string };
  roles: readonly ApplyRole[];
  /** 조치할 일 글귀: 제목 · "<역할> 이(가) <saved> N분이 지나도 옛 판으로 돕니다. <hint>" */
  attention: { title: string; saved: string; hint: string };
  href: string;
};
export const CRAWL_SETTINGS_APPLY: ApplyKind = {
  key: "settings-apply", fields: { version: "settingsVersion", readAt: "settingsReadAt" }, roles: SETTINGS_ROLES, href: "/admin#apply",
  attention: { title: "저장한 설정이 워커에 닿지 않음", saved: "설정을 저장하고", hint: "설정을 읽는 잡이 돌지 못하고 있는지 운영센터의 역할·작업 표에서 확인하세요." },
};
export const RUNTIME_SETTINGS_APPLY: ApplyKind = {
  key: "runtime-settings-apply", fields: { version: "runtimeSettingsVersion", readAt: "runtimeSettingsReadAt", registryEnv: "runtimeSettingsRegistryEnv" },
  roles: RUNTIME_SETTINGS_ROLES, href: "/admin/models/limits#apply",
  attention: { title: "저장한 실시간 한도가 워커에 닿지 않음", saved: "실시간 한도를 저장하고",
    hint: "그 역할의 워커가 poll 을 돌지 못하고 있는지 운영센터의 역할·작업 표에서 확인하세요(워커는 poll 마다 30초 안에 새 판을 읽습니다)." },
};

/** applied 같은 판 · waiting 옛 판 · unknown 판을 싣지 않는 옛 워커 · inactive 지금 일하는 프로세스가 없음 */
export type RoleApplyState = "applied" | "waiting" | "unknown" | "inactive";
export type RoleSettingsApply = {
  role: ApplyRole;
  label: string;
  reportedVersion: string | null;
  /** 그 역할이 판을 읽은 시각(epoch ms, 워커 시계) */
  observedAt: number | null;
  state: RoleApplyState;
  /** 저장한 지 10분이 지나도 옛 판 */
  lagging: boolean;
  /** 실시간 한도만: 그 역할 프로세스에 MODEL_REGISTRY_CONFIG env 가 있어 경로 한도 저장이 닿지 않는다(판은 읽었어도). 크롤 설정에는 없다 */
  registryEnv?: boolean;
};
/** 운영센터 조치할 일 한 칸에 그대로 옮길 수 있는 모양 */
export type SettingsApplyAttention = { key: ApplyKind["key"]; tone: "hold"; count: number; title: string; detail: string; href: string };
export type SettingsApply = {
  savedVersion: string;
  roles: RoleSettingsApply[];
  /** 모든 역할이 저장된 판으로 돈다 */
  allApplied: boolean;
  attention: SettingsApplyAttention | null;
};

export type ApplyObservation = { key: string; value: Record<string, unknown>; ageSeconds: number };

/** 관측과 저장된 판을 견준다 — DB 없이 시험할 수 있게 나눈다. kind 를 생략하면 크롤 설정이다 */
export function settingsApplyStatus(input: {
  savedVersion: string;
  /** 마지막 저장 뒤 지난 초. 저장한 적이 없으면 null(기본값으로 돈다 — 늦을 것이 없다) */
  savedAgeSeconds: number | null;
  observations: readonly ApplyObservation[];
  kind?: ApplyKind;
}): SettingsApply {
  const kind = input.kind ?? CRAWL_SETTINGS_APPLY;
  const instances = input.observations.flatMap((row) => {
    const parsed = parseServiceObservationKey(row.key);
    // consumer(예: crawler 밑 agent-scan-consumer-m3)는 설정 판을 싣지 않는다 — 역할의 최근 관측을 가리지 않게 뺀다
    return parsed && !isConsumerServiceInstance(parsed.instanceId) ? [{ ...row, role: parsed.role }] : [];
  });
  const roles = kind.roles.map((role): RoleSettingsApply => {
    const label = ROLE_LABELS[role] ?? role;
    // 주·예비가 바뀌면 옛 인스턴스의 관측이 남는다 — 가장 최근 것이 지금 일하는 쪽이다
    const latest = instances.filter((row) => row.role === role).sort((a, b) => a.ageSeconds - b.ageSeconds)[0];
    const status = latest?.value.status;
    if (!latest || latest.ageSeconds > ACTIVE_SECONDS || status === "stopping" || status === "failed") {
      return { role, label, reportedVersion: null, observedAt: null, state: "inactive", lagging: false };
    }
    const version = typeof latest.value[kind.fields.version] === "string" ? latest.value[kind.fields.version] as string : null;
    const readAt = typeof latest.value[kind.fields.readAt] === "number" ? latest.value[kind.fields.readAt] as number : null;
    const state = version === null ? "unknown" : version === input.savedVersion ? "applied" : "waiting";
    const lagging = state === "waiting" && input.savedAgeSeconds !== null && input.savedAgeSeconds > SETTINGS_LAG_SECONDS;
    const registryEnv = kind.fields.registryEnv !== undefined && version !== null ? latest.value[kind.fields.registryEnv] === true : undefined;
    return { role, label, reportedVersion: version, observedAt: readAt, state, lagging, ...(registryEnv === undefined ? {} : { registryEnv }) };
  });
  const lagging = roles.filter((role) => role.lagging);
  const minutes = Math.floor((input.savedAgeSeconds ?? 0) / 60);
  return {
    savedVersion: input.savedVersion,
    roles,
    allApplied: roles.every((role) => role.state === "applied"),
    attention: lagging.length === 0 ? null : {
      key: kind.key, tone: "hold", count: lagging.length,
      title: kind.attention.title,
      detail: `${lagging.map((role) => role.label).join("·")} 이(가) ${kind.attention.saved} ${minutes}분이 지나도 옛 판으로 돕니다. ${kind.attention.hint}`,
      href: kind.href,
    },
  };
}

/** 실시간 한도(runtime_settings)의 적용 확인 — lib/operations/runtime-settings.ts readRuntimeSettingsApply 가 행을 읽어 넘긴다 */
export function runtimeSettingsApplyStatus(input: { savedVersion: string; savedAgeSeconds: number | null; observations: readonly ApplyObservation[] }): SettingsApply {
  return settingsApplyStatus({ ...input, kind: RUNTIME_SETTINGS_APPLY });
}

/** 역할별 service 관측(최근 판·시각 포함). 경과는 DB 시계로 잰다(시각 열은 시간대 없는 UTC 벽시계다). 예전 키(역할 이름만)도 읽는다 */
export async function readApplyObservations(roles: readonly ApplyRole[] = SETTINGS_ROLES): Promise<ApplyObservation[]> {
  const observations = await db.select({
    key: operationsObservations.key, value: operationsObservations.value,
    ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${operationsObservations.observedAt}))::double precision`,
  }).from(operationsObservations)
    .where(or(like(operationsObservations.key, "service:%"), inArray(operationsObservations.key, [...roles])));
  return observations.map((item) => ({ key: item.key, value: item.value, ageSeconds: Number(item.ageSeconds) }));
}

/** 저장된 크롤 설정 판과 역할별 관측을 읽어 견준다 */
export async function readSettingsApply(): Promise<SettingsApply> {
  const [saved, observations] = await Promise.all([
    db.select({
      values: crawlSettings.values,
      ageSeconds: sql<number>`extract(epoch from ((now() at time zone 'utc') - ${crawlSettings.updatedAt}))::double precision`,
    }).from(crawlSettings).where(eq(crawlSettings.id, 1)),
    readApplyObservations(SETTINGS_ROLES),
  ]);
  const row = saved[0];
  return settingsApplyStatus({
    // 행이 없으면 워커도 빈 값(기본값)을 읽는다 — getSettings 와 같은 판이 나온다
    savedVersion: storedSettingsVersion(row?.values),
    savedAgeSeconds: row ? Number(row.ageSeconds) : null,
    observations,
  });
}
