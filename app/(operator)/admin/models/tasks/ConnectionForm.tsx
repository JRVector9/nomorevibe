"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { AI_CLI_TOOL_LABELS, AI_CLI_TOOLS, type AiCliTool } from "@/lib/llm/ai-tasks";
// 형과 순수 함수만 — 서버 모듈(DB)은 actions 를 거친다
import { aiDeviceSlug, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { saveAiConnectionAction, type AiTaskActionState } from "./actions";
import { OpenCodeCatalogFields } from "./OpenCodeCatalogFields";

const INPUT = "rounded border border-line bg-bg p-2 text-[13px]";

/**
 * 「AI 연결」 만들기·고치기. API = 주소(OpenAI 호환 …/v1) + 선택 키 — 저장하면 서버가 GET /models 로 목록을 읽어 함께 저장한다(못 읽으면 이유를 보인다).
 * 키는 다시 보이지 않는다: 비워 두면 저장된 키 그대로, 「키 지우기」로만 지운다. OpenCode는 기존 M3 CLI의 실제 목록·버전을 비동기로 읽고, 다른 CLI는 기존 입력을 유지한다.
 * 장비 이름은 용량 장비(장비 한도 화면의 이름)다 — 비우면 이름에서 만든다. CLI 버전은 1차·2차·Grok 로그인 유지 순위의 CLI 계약에 쓰인다(PR C1).
 */
export function ConnectionForm({ initial, secretBox }: { initial: AiConnectionView | null; secretBox: boolean }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(saveAiConnectionAction, null);
  const [kind, setKind] = useState<"api" | "cli">(initial?.kind ?? "api");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [cliTool, setCliTool] = useState<AiCliTool>(initial?.cliTool ?? "claude");
  const [catalogReady, setCatalogReady] = useState(false);
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const editing = initial !== null;
  const canDisableOffline = initial?.kind === "cli" && initial.cliTool === "opencode" && cliTool === "opencode" && initial.enabled && !enabled;
  const hostConfigured = initial?.kind === "cli" && initial.cliTool === "opencode" && !!initial.baseUrl && initial.hasKey;
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
      <label className="grid gap-1">주소 (OpenAI 호환, …/v1)
        <input name="baseUrl" required defaultValue={initial?.baseUrl ?? ""} placeholder="http://100.77.43.63:8090/v1" autoComplete="off" className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">저장 시 이 API 주소에서 모델 목록을 확인합니다. 확인된 모델은 지원하는 업무의 순위에서 바로 선택할 수 있으며, 호출은 등록한 API 주소로 직접 보냅니다.</span></label>
      <label className="grid gap-1">API 키 {initial?.hasKey ? "(저장됨 — 비워 두면 그대로)" : "(없으면 비워 둡니다)"}
        <input name="apiKey" type="password" autoComplete="off" disabled={!secretBox} className={INPUT}
          placeholder={secretBox ? "" : "이 서버에는 키 암호화 설정이 없어 키를 저장할 수 없습니다"} /></label>
      {initial?.hasKey && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="clearKey" value="1" />저장된 키 지우기</label>}
      <label className="grid gap-1">컨텍스트 상한(토큰) — /models 가 최대 길이를 알려 주지 않는 엔진에만
        <input name="contextTokens" type="number" inputMode="numeric" min={1} max={2097152} step={1} defaultValue={initial?.contextTokens ?? ""}
          placeholder="예: 131072 — 엔진이 알려 주면 비워 둡니다" autoComplete="off" className={`${INPUT} font-mono`} /></label>
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
      <label className="grid gap-1">CLI 버전 — 1차·2차 심사·Grok 로그인 유지에 쓰려면 필요합니다
        <input name="cliVersion" maxLength={80} defaultValue={initial?.cliVersion ?? ""} placeholder="워커에서 claude --version 을 실행한 출력 그대로" autoComplete="off"
          className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">이 화면은 CLI 를 띄우지 않아 버전을 확인하지 못합니다. 워커 로그 cli_contract.probe 의 observedVersion 을 그대로 적으세요 —
          부를 때 워커의 버전과 다르면 그 순위는 쓰이지 않고 상태 화면에 까닭이 보입니다. 바꾼 뒤에는 그 CLI 를 쓰는 순위 줄을 다시 저장해 계약을 바꿉니다.</span></label>
      </>}
    </>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1">장비 이름(용량)
        <input name="deviceId" maxLength={120} defaultValue={initial?.deviceId ?? ""} placeholder={aiDeviceSlug(label || "engine")} autoComplete="off" className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">장비 한도 화면의 장비 이름입니다. 없으면 순위를 저장할 때 아래 칸 수로 만듭니다.</span></label>
      <label className="grid gap-1">칸 수(동시에 처리할 수)
        <input name="capacitySlots" type="number" inputMode="numeric" min={1} max={256} step={1} defaultValue={initial?.capacitySlots ?? 1} className={`${INPUT} font-mono`} />
        <span className="text-[13px] text-fg-3">장비 행이 이미 있으면 그 값이 이깁니다(장비 한도 화면에서 바꿉니다).</span></label>
    </div>
    <label className="grid gap-1">상태
      <select name="enabled" value={enabled ? "1" : "0"} onChange={event => setEnabled(event.target.value !== "0")} className={INPUT}>
        <option value="1">켜짐</option><option value="0">꺼짐 — 순위 선택지에서 뺍니다(저장된 순위는 남습니다)</option></select></label>
    <label className="grid gap-1">메모<input name="note" maxLength={400} defaultValue={initial?.note ?? ""} className={INPUT} /></label>
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending || (kind === "cli" && cliTool === "opencode" && (!catalogReady || !hostConfigured) && !canDisableOffline)} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">
        {pending ? (kind === "api" ? "모델 목록 읽는 중…" : "저장 중…") : editing ? "연결 저장" : "연결 만들기"}</button>
      {editing && <Link href="/admin/models/tasks#connections" prefetch={false} className="text-[13px] text-fg-3 underline">고치기 그만두기</Link>}
    </div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
