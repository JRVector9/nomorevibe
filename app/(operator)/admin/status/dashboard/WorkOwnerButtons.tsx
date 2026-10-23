"use client";
import { useEffect, useId, useState } from "react";
import { OperationsDialog } from "../OperationsDialog";
import type { WorkOwners } from "../work-owners";

/**
 * 조치 칸의 장비·LLM 버튼 — 장비 이름(M3·mini·Oracle)과 LLM 이름이 곧 버튼이다. 누르면 그 일을 누가·어디서·어떤 주기로 하는지 창으로 본다.
 *
 * 창은 누를 때만 그린다 — 칸이 열 개 넘어도 dialog 를 미리 두지 않는다. 누른 버튼의 묶음으로 창을 내리고 색을 입힌다.
 * 창은 조치 목록(.dash-todo) 안에 그려지므로 목록의 li·a·.t·.d 규칙에 걸리지 않게 div 와 자기 이름만 쓴다.
 */
export function WorkOwnerButtons({ owners, title }: { owners: WorkOwners; title: string }) {
  const [focus, setFocus] = useState<string | null>(null);
  const buttons = [
    ...owners.hosts.map((host) => ({ key: `host:${host.name}`, kind: "host", name: host.name, hint: `${host.name} — 맡은 장비 자세히` })),
    ...owners.models.map((model) => ({ key: `model:${model.name}`, kind: "model", name: model.name, hint: `${model.full} — 쓰는 LLM 자세히` })),
  ];
  // 장비도 LLM 도 모를 때(작업을 비우는 중 등) 작업 일정만이라도 열 수 있게
  if (buttons.length === 0 && owners.jobs.length > 0) buttons.push({ key: "jobs", kind: "host", name: "작업 일정", hint: "맡은 작업과 일정 자세히" });
  if (buttons.length === 0) return null;
  return (
    <div className="dash-owner" role="group" aria-label="맡은 장비·LLM">
      {buttons.map((button) => (
        <button key={button.key} type="button" className="dash-owner-btn" data-kind={button.kind} aria-haspopup="dialog" title={button.hint}
          onClick={() => setFocus(button.key)}>{button.name}</button>
      ))}
      {focus && <OwnerDialog owners={owners} title={title} focus={focus} onClose={() => setFocus(null)} />}
    </div>
  );
}

const TONE_TEXT = { ok: "정상", warn: "주의", bad: "문제" } as const;

function OwnerDialog({ owners, title, focus, onClose }: { owners: WorkOwners; title: string; focus: string; onClose: () => void }) {
  const id = useId();
  const anchor = (key: string) => `${id}-${key}`;
  // 누른 버튼의 묶음까지 창 안에서 내린다
  useEffect(() => { document.getElementById(`${id}-${focus}`)?.scrollIntoView({ block: "nearest" }); }, [id, focus]);
  return (
    <OperationsDialog labelledBy={anchor("title")} onClose={onClose}>
      <div className="dash-owner-modal">
        <div className="dash-owner-head">
          <div>
            <h2 id={anchor("title")}>{title}</h2>
            <div className="dash-owner-sub">이 일을 맡은 장비 · LLM · 작업 일정</div>
          </div>
          <button type="button" className="dash-owner-close" onClick={onClose}>닫기</button>
        </div>

        <div className="dash-owner-sec" role="region" aria-label="장비">
          <h3>장비</h3>
          {owners.hosts.length === 0 && <div className="dash-owner-none">지금 이 일을 맡은 장비를 관측하지 못했습니다.</div>}
          {owners.hosts.map((host) => (
            <div key={host.name} id={anchor(`host:${host.name}`)} className="dash-owner-grp" data-focus={focus === `host:${host.name}` || undefined}>
              <div className="dash-owner-name">{host.name}</div>
              {host.rows.map((row) => (
                <div key={`${row.instanceId}:${row.what}`} className="dash-owner-row">
                  <div><b>{row.what}</b>{row.instanceId !== host.name && <> <span className="dash-owner-code">{row.instanceId}</span></>}</div>
                  <div className="dash-owner-meta">
                    <span className="dash-pill" data-tone={row.tone ?? undefined}>{row.tone && <span className="dash-dot" data-tone={row.tone} aria-hidden />}{row.state}{row.tone ? <span className="sr-only"> · {TONE_TEXT[row.tone]}</span> : null}</span>
                    {row.release && <span>릴리스 <span className="dash-owner-code">{row.release}</span></span>}
                    {row.seen && <span>관측 {row.seen}</span>}
                  </div>
                  <div className="dash-owner-meta">맡은 일: {row.jobs.join(" · ")}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="dash-owner-sec" role="region" aria-label="LLM">
          <h3>LLM</h3>
          {owners.models.length === 0 && <div className="dash-owner-none">이 일에는 LLM 을 쓰지 않습니다.</div>}
          {owners.models.map((model) => (
            <div key={model.name} id={anchor(`model:${model.name}`)} className="dash-owner-grp" data-focus={focus === `model:${model.name}` || undefined}>
              <div className="dash-owner-name" title={model.full}>{model.name}{model.full !== model.name && <span className="dash-owner-code"> {model.full}</span>}</div>
              {model.rows.map((row) => (
                <div key={`${row.slot}:${row.job}`} className="dash-owner-row">
                  <div><b>{row.slot}</b> — {row.job}</div>
                  <div className="dash-owner-meta"><span>실행 위치 {row.runsOn}</span><span>공급 {row.provider}</span></div>
                  <div className="dash-owner-meta"><span>정한 곳 {row.source}</span>{row.stats && <span>{row.stats}</span>}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="dash-owner-sec" role="region" aria-label="작업 일정" id={anchor("jobs")} data-focus={focus === "jobs" || undefined}>
          <h3>작업 · 일정</h3>
          {owners.jobs.map((job) => (
            <div key={job.name} className="dash-owner-grp">
              <div className="dash-owner-name">{job.label} <span className="dash-owner-code">{job.name}</span></div>
              <div className="dash-owner-meta"><span>{job.schedule}</span><span>{job.role}</span>{job.lane !== "—" && <span>{job.lane}</span>}</div>
              {job.state && (
                <div className="dash-owner-meta"><span>상태 {job.state}</span><span>마지막 실행 {job.lastRun ?? "없음"}</span>
                  <span>마지막 성공 {job.lastSuccess ?? "없음"}</span>{job.next && <span>다음 예약 {job.next}</span>}</div>
              )}
              {job.how && <div className="dash-owner-how">{job.how}</div>}
            </div>
          ))}
        </div>

        {owners.notes.map((note) => <div key={note} className="dash-owner-note">{note}</div>)}
      </div>
    </OperationsDialog>
  );
}
