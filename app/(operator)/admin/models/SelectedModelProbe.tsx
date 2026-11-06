"use client";

import { useEffect, useRef, useState } from "react";

type Choice = { provider: string; model: string; reasoningEffort?: string };
type Result = { ok: boolean; ms?: number; error?: string; auditWarning?: boolean };
const MESSAGES: Record<string, string> = {
  unauthorized: "관리자 로그인이 필요합니다.", forbidden: "관리자 화면에서 다시 요청해주세요.", invalid_request: "모델 선택을 확인해주세요.",
  not_found: "사용할 수 없는 연결입니다.", disabled: "연결 또는 모델 접수가 꺼져 있습니다.",
  model_unavailable: "연결에 등록된 모델이 아닙니다.", reasoning_effort_unsupported: "이 모델의 추론 설정을 확인해주세요.",
  device_unknown: "공유 슬롯 상태를 확인하지 못했습니다.", occupied: "공유 슬롯이 사용 중입니다. 잠시 후 확인해주세요.",
  draining: "모델 호출 접수가 중지돼 있습니다.", cooldown: "같은 장비는 1분 뒤 다시 확인할 수 있습니다.",
  probe_failed: "실제 모델 응답을 확인하지 못했습니다.", host_unavailable: "CLI 진단을 확인하지 못했습니다. 호스트 bridge 업데이트·연결을 확인해주세요.",
  timeout: "진단 호출 제한 시간을 넘었습니다.", output_too_large: "진단 응답 크기를 초과했습니다.",
  invalid_output: "완료된 모델 응답을 확인하지 못했습니다.", cli_error: "CLI 호출을 완료하지 못했습니다.",
  busy: "다른 CLI 진단이 진행 중입니다.", audit_unavailable: "진단 기록을 남기지 못해 호출하지 않았습니다.",
  result_audit_failed: "호출 후 결과 기록을 저장하지 못했습니다. 자동 재시도하지 않습니다. 작업 로그를 확인해주세요.",
  secret_unavailable: "연결 인증을 읽지 못했습니다.", base_url_invalid: "등록된 API 주소를 확인해주세요.",
  unsupported_cli: "이 CLI 유형은 응답 진단을 지원하지 않습니다.",
  unavailable: "진단 상태를 확인하지 못했습니다.",
};

/** A selected, unsaved connection/model only. Changing selection never reuses an earlier result. */
export function SelectedModelProbe({ choice, disabled = false }: { choice: Choice | null; disabled?: boolean }) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [savedResult, setResult] = useState<{ key: string; value: Result } | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const key = JSON.stringify(choice && [choice.provider, choice.model, choice.reasoningEffort ?? ""]);
  const busy = busyKey === key;
  const result = savedResult?.key === key ? savedResult.value : null;
  useEffect(() => () => { generation.current++; request.current?.abort(); request.current = null; }, [key]);

  const probe = async () => {
    if (!choice || disabled || request.current) return;
    const controller = new AbortController(), own = ++generation.current;
    request.current = controller;
    setBusyKey(key); setResult(null);
    try {
      const response = await fetch("/api/admin/models/selected-probe", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ connectionId: choice.provider, model: choice.model,
          ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) }) });
      const value = await response.json();
      if (generation.current !== own || controller.signal.aborted) return;
      setResult({ key, value: { ok: response.ok && value.ok === true, ...(typeof value.ms === "number" && Number.isFinite(value.ms) ? { ms: value.ms } : {}),
        auditWarning: value.auditWarning === "result_audit_failed",
        error: typeof value.error === "string" && value.error in MESSAGES ? value.error : "probe_failed" } });
    } catch {
      if (generation.current === own && !controller.signal.aborted) setResult({ key, value: { ok: false, error: "probe_failed" } });
    } finally {
      if (request.current === controller) request.current = null;
      if (generation.current === own) setBusyKey(null);
    }
  };
  return <div className="fr-response-probe">
    <button type="button" className="fr-btn" onClick={() => void probe()} disabled={disabled || !choice || busy}>
      {busy ? "응답 확인 중…" : "응답 테스트"}</button>
    <span role="status" className="fr-probe-result" data-ok={result ? String(result.ok) : undefined}>
      {result ? result.ok ? `응답 확인${typeof result.ms === "number" ? ` · ${Math.round(result.ms).toLocaleString("ko-KR")}ms` : ""}` : MESSAGES[result.error ?? "probe_failed"] : "선택한 모델에 짧은 진단 호출"}
    </span>
    {result?.auditWarning && <span className="fr-probe-result" data-ok="false">응답 결과 기록 저장 실패 · 자동 재시도하지 않습니다. 작업 로그를 확인해주세요.</span>}
  </div>;
}
