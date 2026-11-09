"use client";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

const subscribe = (notify: () => void) => { window.addEventListener("hashchange", notify); return () => window.removeEventListener("hashchange", notify); };
const readHash = () => { try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return window.location.hash.slice(1); } };
const serverHash = () => "";

/**
 * 도우미 배정 한 줄 + 그 아래 펼침 줄(배정별 설정). 「설정」 단추가 펼침 줄을 열고 닫는다.
 * 주소의 #helper-<배정>(작업 배정 화면·자동 정지 표·서버 이름 링크가 보내는 곳)이면 처음부터 열고 그 폼으로 내려간다.
 * 닫혀 있어도 폼은 그려 두고 hidden 으로만 숨긴다 — 서버가 그린 값(판·기본값)이 그대로이고, 입력 중인 값이 닫았다 열어도 남는다.
 */
export function HelperRow({ assignmentId, label, cells, detail, colSpan }: { assignmentId: string; label: string; cells: ReactNode; detail: ReactNode; colSpan: number }) {
  const formId = `helper-${assignmentId}`;
  const hashOpen = useSyncExternalStore(subscribe, readHash, serverHash) === formId;
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? hashOpen;
  useEffect(() => {
    if (!hashOpen) return;
    document.getElementById(formId)?.scrollIntoView({ block: "start" });
  }, [hashOpen, formId]);
  return <>
    <tr data-assignment={assignmentId} data-open={open || undefined}>
      {cells}
      <td><div className="mh-acts">
        <button type="button" className="mh-btn" aria-expanded={open} aria-controls={`${formId}-row`} aria-label={`${label} 설정 ${open ? "닫기" : "열기"}`}
          onClick={() => setToggled(!open)}>설정</button>
      </div></td>
    </tr>
    <tr id={`${formId}-row`} className="mh-form-row" hidden={!open}><td colSpan={colSpan}>{detail}</td></tr>
  </>;
}
