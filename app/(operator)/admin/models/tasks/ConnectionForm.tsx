"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { AI_CLI_TOOL_LABELS, AI_CLI_TOOLS, AI_TASK_GROUP_LABELS, AI_TASKS, type AiCliTool } from "@/lib/llm/ai-tasks";
// 형과 순수 함수만 — 서버 모듈(DB)은 actions 를 거친다
import { AI_REASONING_TOKEN_RESERVE_MAX, aiAllowedTaskField, aiDeviceSlug, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { llmFieldAnchor, type LlmFixField } from "@/lib/operations/llm-ops-links";
import { saveAiConnectionAction, type AiTaskActionState } from "./actions";
import { saveCapacityDevice } from "../devices/actions";
import { OpenCodeCatalogFields } from "./OpenCodeCatalogFields";

const INPUT = "rounded border border-line bg-bg p-2 text-[13px]";
/** ISO 시각 → KST 날짜(YYYY-MM-DD). 서버·브라우저가 같은 글을 그리게 Intl 을 쓰지 않는다 */
const kstDay = (at: string) => new Date(Date.parse(at) + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * 「칸 수」 대신 장비 행(실제 적용 값)의 「동시 실행 한도」 한 칸(2026-11-07 PR 2, PR 4 에서 옛 「칸 수」 칸을 없앴다 — 장비 행이 있으면 그 값이 이겨 헷갈렸다).
 * 연결 저장(saveAiConnectionAction)이 끝나면 값이 바뀐 때만 같은 장비 행을 기존 공유 한도 저장(saveCapacityDevice formMode=shared-limit)으로 저장한다.
 * eligible 이 아니면(정책 경로가 아직 없는 장비 등) 값은 연결의 칸 수로만 남는다 — 순위를 저장할 때 장비 행을 만드는 값이다.
 */
export type ConnectionLimitField = Readonly<{ deviceId: string; current: number | null; expectedVersion: number | null; policyHash: string | null;
  eligible: boolean; reason: string | null; sharedWith: readonly string[];
  /** 연결에 남은 옛 칸 수 — 장비 행(실제 적용 값)과 다를 때만. 칸은 장비 행 값으로 채워져 있어 그대로 저장하면 연결 값도 맞춰진다 */
  stale?: number | null }>;
/** 저장 뒤 바로 보일 모델 목록(새로 그린 화면의 값) — 연결 id 로 찾는다. */
export type ConnectionSavedModels = Readonly<{ id: string; models: readonly string[]; error: string | null }>;

/**
 * 연결에 옛 칸 수가 남아 장비 행과 다를 때, 한도 칸 아래 한 줄 — 지금 칸의 값으로 저장하면 무엇이 되는지(saveConnectionWithLimit 그대로).
 * 장비 행 값 그대로면 연결 값만 맞춰지고, 바꾸면 저장할 수 있는 장비는 둘 다 바뀌며, 저장할 수 없는 장비는 연결 값만 바뀌어 다시 어긋난다.
 */
export function connectionLimitHint(limit: ConnectionLimitField, value: string): string | null {
  if (limit.stale == null || limit.current === null) return null;
  const wanted = Number(value);
  if (!Number.isSafeInteger(wanted) || wanted < 1 || wanted > 256) return null;
  if (wanted === limit.current) return `저장하면 연결 값도 ${wanted}(으)로 맞춰집니다(연결에 남은 옛 값 ${limit.stale}).`;
  return limit.eligible ? `저장하면 연결과 장비 행 모두 ${wanted}(으)로 바뀝니다.`
    : `여기서는 장비 행을 바꾸지 못해 연결 값만 ${wanted}(으)로 바뀝니다 — 맞추려면 ${limit.current} 그대로 저장하세요.`;
}
/** 고칠 칸(?fix=)에 붙는 짧은 안내 — 한도는 connectionLimitHint 가 따로 늘 보인다. */
const FIX_HINT: Readonly<Partial<Record<LlmFixField, string>>> = {
  key: "키를 넣고 「저장하고 모델 읽기」를 누르세요.",
  address: "주소·키를 확인하고 「저장하고 모델 읽기」를 누르세요.",
};

/** 연결 저장 → (바뀌었으면) 장비 한도 저장. 두 기존 서버 동작을 차례로 부른다 — 새 쓰기 경로가 없다. */
export async function saveConnectionWithLimit(limit: ConnectionLimitField | null, form: FormData,
  actions = { connection: saveAiConnectionAction, device: saveCapacityDevice }): Promise<AiTaskActionState> {
  const saved = await actions.connection(null, form);
  if (!limit || !saved?.ok) return saved;
  const wanted = Number(form.get("capacitySlots"));
  if (!limit.eligible || limit.current === null || !Number.isSafeInteger(wanted) || wanted === limit.current) return saved;
  const typed = String(form.get("deviceId") ?? "").trim();
  if (typed !== limit.deviceId)
    return { ...saved, warnings: [...saved.warnings ?? [], "장비 이름을 바꿔 동시 실행 한도는 저장하지 않았습니다. 새 장비로 다시 펼쳐 저장하세요."] };
  const shared = new FormData();
  shared.set("formMode", "shared-limit"); shared.set("deviceId", limit.deviceId); shared.set("limitSlots", String(wanted));
  shared.set("expectedVersion", limit.expectedVersion === null ? "" : String(limit.expectedVersion)); shared.set("policyHash", limit.policyHash ?? "");
  const device = await actions.device(null, shared);
  if (device?.ok) return { ...saved, message: `${saved.message} 동시 실행 한도: ${device.message}` };
  return { ...saved, issues: (device?.issues ?? ["저장 결과를 확인하지 못했습니다."]).map(issue => `연결은 저장했지만 동시 실행 한도는 저장하지 못했습니다: ${issue}`) };
}

/**
 * 「AI 연결」 만들기·고치기 — LLM 운영(/admin/models/llm)의 연결 행과 「+ 연결 추가」가 쓴다(작업 배정 화면의 옛 연결 폼은 없앴다).
 * API = 주소(OpenAI 호환 …/v1) + 선택 키 — 저장하면 서버가 GET /models 로 목록을 읽어 함께 저장한다(못 읽으면 이유를 보인다).
 * 키는 다시 보이지 않는다: 비워 두면 저장된 키 그대로, 「키 지우기」로만 지운다. OpenCode는 기존 M3 CLI의 실제 목록·버전을 비동기로 읽고, 다른 CLI는 기존 입력을 유지한다.
 * 장비 이름은 용량 장비(장비 한도 화면의 이름)다 — 비우면 이름에서 만든다. CLI 버전은 1차·2차·Grok 로그인 유지 순위의 CLI 계약에 쓰인다(PR C1).
 * 고치는 칸(한도·키·주소·CLI 버전·상태)은 id 가 conn-<연결>-<칸> 이라 LLM 운영 행의 문제 표시가 ?fix=<칸>#conn-<연결>-<칸> 으로 바로 온다 — 그 칸으로 내려가 초점을 둔다.
 */
export function ConnectionForm({ initial, secretBox, limit: given = null, cancelHref = "/admin/models/llm", savedModels, readOnly = false, fix = null }: {
  initial: AiConnectionView | null; secretBox: boolean;
  /** 장비 행 「동시 실행 한도」 한 칸. 없으면(장부를 못 읽음 등) 장비 행을 바꾸지 않는 칸 — 값은 연결에만 남고 순위 저장이 장비 행을 만들 때 쓴다 */
  limit?: ConnectionLimitField | null; cancelHref?: string;
  /** LLM 운영 화면: 새로 만든 연결의 모델 목록을 저장 직후 보인다 */
  savedModels?: readonly ConnectionSavedModels[]; readOnly?: boolean;
  /** 고칠 칸(LLM 운영 ?fix=) — 눈에 띄게 하고 처음 그릴 때 초점을 둔다 */
  fix?: LlmFixField | null;
}) {
  const limit: ConnectionLimitField = given ?? { deviceId: initial?.deviceId ?? "", current: null, expectedVersion: null, policyHash: null, eligible: false, reason: null, sharedWith: [] };
  const connectionId = initial?.id ?? null;
  const [slots, setSlots] = useState(String(limit.current ?? initial?.capacitySlots ?? 1));
  const limitHint = connectionLimitHint(limit, slots);
  // 문제 표시에서 왔으면 그 칸으로 내려가 초점을 둔다(펼친 행은 서버가 open 으로 그린다). 꺼진 칸은 초점만 건너뛴다
  useEffect(() => {
    if (!fix || !connectionId) return;
    const field = document.getElementById(llmFieldAnchor(connectionId, fix));
    field?.scrollIntoView({ block: "center" });
    field?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus({ preventScroll: true });
  }, [fix, connectionId]);
  /** 고칠 수 있는 칸의 label — 주소의 #조각이 가리키고, 고칠 칸이면 data-fix 로 눈에 띈다 */
  const fixField = (field: LlmFixField) => connectionId ? { id: llmFieldAnchor(connectionId, field), "data-fix-field": field, "data-fix": fix === field ? "true" : undefined } : {};
  const fixHint = (field: LlmFixField) => fix === field && FIX_HINT[field] ? <span className="llm-fix-hint text-[13px]">{FIX_HINT[field]}</span> : null;
  // 연결 저장 → (바뀌었으면) 장비 한도 저장을 차례로 부른다(saveConnectionWithLimit).
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>((_previous, form) => saveConnectionWithLimit(limit, form), null);
  const [kind, setKind] = useState<"api" | "cli">(initial?.kind ?? "api");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [cliTool, setCliTool] = useState<AiCliTool>(initial?.cliTool ?? "claude");
  const [catalogReady, setCatalogReady] = useState(false);
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const editing = initial !== null;
  const canDisableOffline = initial?.kind === "cli" && initial.cliTool === "opencode" && cliTool === "opencode" && initial.enabled && !enabled;
  const hostConfigured = initial?.kind === "cli" && initial.cliTool === "opencode" && !!initial.baseUrl && initial.hasKey;
  const created = state?.ok && !editing && state.connectionId ? savedModels?.find(row => row.id === state.connectionId) ?? null : null;
  return <form action={action} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <input type="hidden" name="id" value={initial?.id ?? ""} />
    <input type="hidden" name="expectedVersion" value={initial?.version ?? ""} />
    <fieldset className="flex flex-wrap gap-4" disabled={editing}>
      <legend className="mb-1 text-[13px] font-semibold text-fg-2">종류{editing ? " — 바꾸려면 새 연결을 만드세요" : ""}</legend>
      <label className="flex items-center gap-2"><input type="radio" name="kind" value="api" checked={kind === "api"} onChange={() => { setKind("api"); setCatalogReady(false); }} />API 주소(엔진)</label>
      <label className="flex items-center gap-2"><input type="radio" name="kind" value="cli" checked={kind === "cli"} onChange={() => { setKind("cli"); setCatalogReady(false); }} />CLI 도구</label>
    </fieldset>
    {editing && <input type="hidden" name="kind" value={kind} />}
    <label className="grid gap-1">이름(화면에 보이는 이름, 예: gpu3090 · M3 gpt-oss)
      <input name="label" required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} autoComplete="off" className={INPUT} /></label>
    {kind === "api" ? <>
      <label className="grid gap-1" {...fixField("address")}>주소 (OpenAI 호환, …/v1)
        <input name="baseUrl" required defaultValue={initial?.baseUrl ?? ""} placeholder="http://100.77.43.63:8090/v1" autoComplete="off" className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">저장 시 이 API 주소에서 모델 목록을 확인합니다. 확인된 모델은 지원하는 업무의 순위에서 바로 선택할 수 있으며, 호출은 등록한 API 주소로 직접 보냅니다.</span>
        {fixHint("address")}</label>
      <label className="grid gap-1" {...fixField("key")}>API 키 {initial?.hasKey ? "(저장됨 — 비워 두면 그대로)" : "(없으면 비워 둡니다)"}
        <input name="apiKey" type="password" autoComplete="off" disabled={!secretBox} className={INPUT}
          placeholder={secretBox ? "" : "이 서버에는 키 암호화 설정이 없어 키를 저장할 수 없습니다"} />{fixHint("key")}</label>
      {initial?.hasKey && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="clearKey" value="1" />저장된 키 지우기</label>}
      <label className="grid gap-1">컨텍스트 상한(토큰) — /models 가 최대 길이를 알려 주지 않는 엔진에만
        <input name="contextTokens" type="number" inputMode="numeric" min={1} max={2097152} step={1} defaultValue={initial?.contextTokens ?? ""}
          placeholder="예: 131072 — 엔진이 알려 주면 비워 둡니다" autoComplete="off" className={`${INPUT} font-mono`} /></label>
      <label className="grid gap-1">모델 이름 직접 적기 — 모델 목록(GET /models)을 주지 않는 서버에만
        <textarea name="manualModels" rows={1} defaultValue={initial?.manualModels?.join(" ") ?? ""} placeholder="예: k-exaone_v2.5 (띄어쓰기·쉼표로 나눔)"
          className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">목록이 없어도 이 이름이 순위·작업 분산 선택지에 오릅니다. 저장할 때 목록 대조 없이 1토큰 시험 호출로 확인하고,
          계약 상한은 위 「컨텍스트 상한」을 씁니다(비우면 저장이 막힙니다).</span></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">추론 토큰 여유 — 추론이 max_tokens 에 포함되는 추론 모델만
          <input name="reasoningTokenReserve" type="number" inputMode="numeric" min={1} max={AI_REASONING_TOKEN_RESERVE_MAX} step={1}
            defaultValue={initial?.reasoningTokenReserve ?? ""} placeholder="예: 4096 — 일반 모델은 비워 둡니다" autoComplete="off" className={`${INPUT} font-mono`} />
          <span className="text-[13px] text-fg-3">심사 사유 번역 요청의 max_tokens 에 더합니다. 그 작업의 계약을 처음 만들 때 계약에 들어갑니다(나중에 바꾸면 계약을 끄고 다시 저장).</span></label>
        <label className="grid gap-1">키 유효 기간(일) — 키가 정해진 날 뒤 만료되는 API만
          <input name="keyValidDays" type="number" inputMode="numeric" min={1} max={3650} step={1} defaultValue={initial?.keyValidDays ?? ""}
            placeholder="예: 30" autoComplete="off" className={`${INPUT} font-mono`} />
          <span className="text-[13px] text-fg-3">키를 넣은 날부터 세어 LLM 운영에 만료일을 보이고, 5일 안으로 남으면 상태에 알립니다.
            {initial?.keySetAt ? ` 지금 키를 넣은 날: ${kstDay(initial.keySetAt)}(KST).` : ""}</span></label>
      </div>
    </> : <>
      <label className="grid gap-1">CLI 도구
        <select name="cliTool" value={cliTool} onChange={event => { setCliTool(event.target.value as AiCliTool); setCatalogReady(false); }} className={INPUT}>
          {AI_CLI_TOOLS.map(tool => <option key={tool} value={tool}>{AI_CLI_TOOL_LABELS[tool]}</option>)}</select></label>
      {cliTool === "opencode" ? <>
        {!hostConfigured && <p role="note" className="text-[13px] text-fg-3">기존 M3 호스트 연결을 등록한 뒤 해당 연결을 편집하세요. 이 폼은 호스트 주소·RPC 인증 정보를 새로 만들지 않습니다.</p>}
        <OpenCodeCatalogFields initial={initial?.cliTool === "opencode" ? initial : null} onReady={setCatalogReady} />
      </> : <>
      <label className="grid gap-1">모델 이름(띄어쓰기·쉼표로 나눔 — CLI 에는 목록이 없어 직접 적습니다)
        <textarea name="cliModels" required rows={2} defaultValue={initial?.cliModels.join(" ") ?? ""} placeholder="sonnet opus" className={`${INPUT} font-mono`} /></label>
      <label className="grid gap-1" {...fixField("version")}>CLI 버전 — 1차·2차 심사·Grok 로그인 유지에 쓰려면 필요합니다
        <input name="cliVersion" maxLength={80} defaultValue={initial?.cliVersion ?? ""} placeholder="워커에서 claude --version 을 실행한 출력 그대로" autoComplete="off"
          className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">이 화면은 CLI 를 띄우지 않아 버전을 확인하지 못합니다. 워커 로그 cli_contract.probe 의 observedVersion 을 그대로 적으세요 —
          부를 때 워커의 버전과 다르면 그 순위는 쓰이지 않고 상태 화면에 까닭이 보입니다. 바꾼 뒤에는 그 CLI 를 쓰는 순위 줄을 다시 저장해 계약을 바꿉니다.</span></label>
      </>}
    </>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1">장비 이름(용량)
        <input name="deviceId" maxLength={120} defaultValue={initial?.deviceId ?? ""} placeholder={aiDeviceSlug(label || "engine")} autoComplete="off" className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">장비 한도 화면의 장비 이름입니다. 없으면 순위를 저장할 때 옆 동시 실행 한도로 만듭니다.</span></label>
      <label className="grid gap-1" {...fixField("limit")}>동시 실행 한도(장비 행 · 실제 적용 값)
        <input name="capacitySlots" type="number" inputMode="numeric" min={1} max={256} step={1} defaultValue={limit.current ?? initial?.capacitySlots ?? 1}
          onChange={event => setSlots(event.target.value)} className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">{limit.deviceId ? `장비 ${limit.deviceId}` : "새 장비"}{limit.sharedWith.length ? ` · ${limit.sharedWith.join(", ")}와 함께 씀` : ""}.
          {" "}{limit.eligible ? "값을 바꿔 저장하면 장비 행도 이 값으로 바뀝니다 — 같은 장비를 쓰는 모든 작업이 이 한도를 나눠 씁니다." : limit.reason ?? "새 연결은 순위를 저장할 때 이 값으로 장비 행을 만듭니다(같은 이름의 장비 행이 있으면 그 값이 쓰입니다)."}</span>
        {limitHint && <span className="llm-fix-hint text-[13px]" data-limit-hint="true">{limitHint}</span>}</label>
    </div>
    <details className="grid gap-1" open={(initial?.allowedTasks?.length ?? 0) > 0 || undefined}>
      <summary className="cursor-pointer">쓸 수 있는 작업{initial?.allowedTasks?.length ? ` — ${initial.allowedTasks.length}개로 제한됨` : " — 제한 없음(모든 작업)"}</summary>
      <p className="text-[13px] text-fg-3">체크한 작업에서만 이 연결을 고를 수 있고, 실행 쪽도 다른 작업에는 부르지 않습니다. 아무것도 체크하지 않으면 모든 작업입니다.
        약관이 상업적 이용을 막는 API(비상업 전용 키 등)는 관리자만 보는 작업(예: 심사 사유 번역)에만 체크하세요 — 공개 화면에 나가는 번역·소개에 쓰면 약관 위반일 수 있습니다.</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {AI_TASKS.filter(task => kind === "api" ? task.api : task.cliTools.includes(cliTool)).map(task =>
          <label key={task.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" name={aiAllowedTaskField(task.id)} value="1"
            defaultChecked={initial?.allowedTasks?.includes(task.id) ?? false} />{AI_TASK_GROUP_LABELS[task.group]} · {task.label}</label>)}
      </div>
    </details>
    <label className="grid gap-1" {...fixField("enabled")}>상태
      <select name="enabled" value={enabled ? "1" : "0"} onChange={event => setEnabled(event.target.value !== "0")} className={INPUT}>
        <option value="1">켜짐</option><option value="0">꺼짐 — 순위 선택지에서 뺍니다(저장된 순위는 남습니다)</option></select></label>
    <label className="grid gap-1">메모<input name="note" maxLength={400} defaultValue={initial?.note ?? ""} className={INPUT} /></label>
    <div className="flex flex-wrap items-center gap-3">
      {/* 승인 시안의 단추(.button.primary)를 쓴다 — 시안 CSS 의 button{color:inherit} 가 층 밖이라 text-bg 유틸리티를 덮어 글자가 안 보였다 */}
      <button type="submit" disabled={readOnly || pending || (kind === "cli" && cliTool === "opencode" && (!catalogReady || !hostConfigured) && !canDisableOffline)}
        className="button primary">
        {pending ? (kind === "api" ? "모델 목록 읽는 중…" : "저장 중…") : kind === "api" ? (editing ? "저장하고 모델 읽기" : "만들고 모델 읽기") : editing ? "연결 저장" : "연결 만들기"}</button>
      {editing && <Link href={cancelHref} prefetch={false} className="text-[13px] text-fg-3 underline">고치기 그만두기</Link>}
    </div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.warnings?.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">{text}</p>)}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
    {created && <div className="grid gap-1 text-[13px]" data-created-models={created.id}><p className="font-semibold">이 서버의 모델 {created.models.length}개{created.error ? ` · 마지막 오류: ${created.error}` : ""}</p>
      {created.models.length > 0 && <ul className="grid max-h-48 gap-0.5 overflow-y-auto rounded border border-line p-2">{created.models.map(model => <li key={model}><code className="break-all">{model}</code></li>)}</ul>}</div>}
  </form>;
}
