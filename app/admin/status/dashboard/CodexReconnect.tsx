/* eslint-disable @next/next/no-html-link-for-pages -- 완료 후 기존 AI 설정 화면을 새로 읽는다 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Countdown } from "../Countdown";
import { OperationsDialog } from "../OperationsDialog";
import { useAgentConnection } from "../useAgentConnection";

const STATES: Record<string, string> = {
  starting: "인증 페이지 준비 중", awaiting_approval: "공식 페이지 승인 대기", exchanging: "인증 확인 중",
  stored: "인증 저장 완료", cancelled: "인증 취소됨", expired: "인증 시간 만료", failed: "인증 실패",
};

/** 오류 칩을 직접 누른 경우에만 인증 창을 열고 계정 연결을 요청한다. */
export function CodexReconnectButton({ result }: { result: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="dash-pill dash-reconnect" data-tone="bad" onClick={() => setOpen(true)}>
      <span className="dash-dot" data-tone="bad" aria-hidden />Codex 연결 {result} · 다시 인증
    </button>
    {open && <CodexReconnectDialog onClose={() => setOpen(false)} />}
  </>;
}

function CodexReconnectDialog({ onClose }: { onClose: () => void }) {
  const { status, pending, transportError, refresh, perform } = useAgentConnection(null);
  const [error, setError] = useState(""), [copied, setCopied] = useState(false), [starting, setStarting] = useState(true);
  const started = useRef(false);
  const connection = status?.connection?.provider === "codex" ? status.connection : null;
  const terminal = connection && ["stored", "failed", "expired", "cancelled"].includes(connection.state);
  const authenticating = status?.busy === "login" && connection && !terminal;
  const busy = Boolean(status?.busy);

  const start = useCallback(async () => {
    setError(""); setCopied(false); setStarting(true);
    try {
      // 관측 칩은 늦을 수 있으므로 실제 상태부터 읽고, 이미 열린 Codex 인증은 이어 본다.
      const current = await perform("status");
      if (current.error) { setError(current.error); return; }
      if (!current.status) { setError("연결 상태를 확인하지 못했습니다. 다시 시도해주세요."); return; }
      if (current.status.busy === "login" && (current.status.connection?.provider ?? "codex") === "codex") return;
      if (current.status.busy) return;
      const result = await perform("connect", { provider: "codex" });
      if (result.error) setError(result.error);
    } finally { setStarting(false); }
  }, [perform]);

  useEffect(() => {
    if (started.current) return;
    const timer = setTimeout(() => { started.current = true; void start(); }, 0);
    return () => clearTimeout(timer);
  }, [start]);

  async function cancel() {
    if (!connection) return;
    setError("");
    const result = await perform("cancel", { id: connection.id });
    if (result.error) setError(result.error);
  }

  return <OperationsDialog labelledBy="codex-reconnect-title" onClose={onClose}>
    <div className="ai-connect-dialog">
      <div className="ops-row"><h2 id="codex-reconnect-title">Codex 다시 인증</h2><button onClick={onClose}>닫기</button></div>
      <p className="ai-dialog-state" role="status">{starting ? "인증 요청 중" : connection ? STATES[connection.state] ?? connection.state : "연결 상태 확인"}</p>
      {transportError && <p className="ai-notice error" role="alert">{transportError}</p>}
      {error && <p className="ai-notice error" role="alert">{error}</p>}
      {busy && !authenticating && <p>다른 AI 작업이 진행 중입니다. 완료 후 다시 인증해주세요.</p>}
      {!starting && connection?.state === "stored" ? <>
        <p>인증을 저장했습니다. 모델 응답을 검사한 뒤 설정을 적용해주세요.</p>
        <a className="ops-button codex-settings-link" href="/admin/status?tab=ai">모델 검사·적용으로 이동</a>
      </> : authenticating ? <>
        <p>공식 페이지에서 아래 코드를 입력하고 계정을 승인해주세요. 승인 결과는 이 창에 자동으로 표시됩니다.</p>
        {connection.url === "https://auth.openai.com/codex/device" && <a className="ops-button codex-settings-link" href={connection.url} target="_blank" rel="noreferrer noopener">공식 인증 페이지 열기 ↗</a>}
        {connection.code && <div className="ai-device"><strong className="ops-device-code">{connection.code}</strong><button onClick={() => void navigator.clipboard.writeText(connection.code!).then(() => setCopied(true)).catch(() => setError("복사할 수 없습니다. 코드를 직접 선택해 복사해주세요."))}>{copied ? "복사됨" : "코드 복사"}</button></div>}
        {status?.serverNow && <Countdown deadlineAt={connection.expiresAt} serverNow={status.serverNow} label="계정 연결 유효시간" />}
      </> : !starting && <>
        {connection?.state === "expired" && <p>인증 시간이 지났습니다. 새 코드로 다시 인증해주세요.</p>}
        {connection?.state === "failed" && <p>인증을 완료하지 못했습니다. 새 인증으로 다시 시도해주세요.</p>}
        <button disabled={pending || busy} onClick={() => void start()}>새 인증 시작</button>
      </>}
      <div className="ai-dialog-footer">
        {authenticating && <button disabled={pending} onClick={() => void cancel()}>인증 취소</button>}
        <button disabled={pending} onClick={() => void refresh()}>지금 상태 확인</button>
      </div>
    </div>
  </OperationsDialog>;
}
