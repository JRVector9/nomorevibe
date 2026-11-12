"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ModelUnifiedRead } from "@/lib/operations/model-unified-read";
import { unifiedTaskDuplicate } from "@/lib/operations/model-unified-task-view";
import { ModelConsole } from "../console/ModelConsole";
import { UnifiedTaskSection } from "./tasks/UnifiedTaskSection";
import { UnifiedTaskEditor } from "./tasks/UnifiedTaskEditor";
import { unifiedSectionHash, unifiedTaskKey } from "./legacy-navigation";
import "./unified.css";

export type UnifiedModelsWorkspaceData = Pick<ModelUnifiedRead, "models" | "assignments" | "editor" | "devices" | "poolHelp" | "lockReason" | "taskUses" | "ranksReadable">;
type Detail = { kind: "model"; id: string } | { kind: "task"; key: string; attachConnectionId?: string } | null;
type Filter = "all" | "attention" | "duplicate";

/** 모델·작업은 한 페이지와 한 상세 상태를 공유한다. 저장은 각 편집기의 기존 액션에만 맡긴다. */
export function UnifiedModelsWorkspace({ data, selected, readOnly, children }: { data: UnifiedModelsWorkspaceData; selected: string | null; readOnly: boolean; children?: ReactNode }) {
  const [detail, setDetail] = useState<Detail>(selected ? { kind: "model", id: selected } : null);
  const [scope, setScope] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const updateAddress = useCallback((next: Detail) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("model"); url.searchParams.delete("task");
    if (next?.kind === "model") { url.searchParams.set("model", next.id); url.hash = "model-detail"; }
    else if (next?.kind === "task") { url.searchParams.set("task", next.key); url.hash = `execution-${next.key.replace("#", "-")}`; }
    else url.hash = "tasks";
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const openTask = useCallback((key: string, attachConnectionId?: string) => {
    const next: Detail = { kind: "task", key, ...(attachConnectionId ? { attachConnectionId } : {}) };
    setDetail(next); updateAddress(next);
  }, [updateAddress]);
  const openModel = useCallback((id: string) => { const next: Detail = { kind: "model", id }; setDetail(next); updateAddress(next); }, [updateAddress]);
  const close = useCallback(() => { setDetail(null); updateAddress(null); }, [updateAddress]);

  useEffect(() => {
    const reveal = () => {
      const url = new URL(window.location.href);
      const hash = unifiedSectionHash(url.hash);
      if (url.hash && hash !== url.hash) {
        url.hash = hash;
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      const keys = data.assignments.rows.map(row => row.key);
      const task = keys.includes(url.searchParams.get("task") ?? "") ? url.searchParams.get("task") : unifiedTaskKey(url.hash, keys);
      if (task) setDetail({ kind: "task", key: task });
      else if (url.searchParams.get("model")) setDetail({ kind: "model", id: url.searchParams.get("model")! });
      let id: string;
      try { id = decodeURIComponent(url.hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target) return;
      for (let fold = target.closest("details"); fold; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
      if (!task && !url.searchParams.get("model")) target.scrollIntoView();
    };
    reveal();
    window.addEventListener("hashchange", reveal); window.addEventListener("popstate", reveal);
    return () => { window.removeEventListener("hashchange", reveal); window.removeEventListener("popstate", reveal); };
  }, [data.assignments.rows]);
  const reviewDuplicates = () => {
    setDetail(null); setScope(null); setFilter("duplicate");
    updateAddress(null);
    document.getElementById("tasks")?.scrollIntoView({ behavior: "smooth" });
  };
  return <div className="models-unified" data-models-unified="true">
    <nav className="mu-jumps" aria-label="모델 화면 바로가기"><a href="#models">모델 목록</a><a href="#tasks">작업별 적용 현황</a><a href="#operations">운영 설정</a></nav>
    <ModelConsole data={data.models} selected={detail?.kind === "model" ? detail.id : null} readOnly={readOnly}
      attach={{ editor: data.editor, poolHelp: data.poolHelp }} taskUses={data.taskUses}
      duplicateCount={data.ranksReadable ? data.assignments.rows.filter(unifiedTaskDuplicate).length : null}
      onModelOpen={openModel} onModelClose={close} onTaskOpen={openTask} onReviewDuplicates={reviewDuplicates}
      onModelScope={id => { setDetail(null); updateAddress(null); setScope(id); setFilter("all"); document.getElementById("tasks")?.scrollIntoView({ behavior: "smooth" }); }} />
    <UnifiedTaskSection view={data.assignments} editor={data.editor} devices={data.devices} lockReason={data.lockReason} poolHelp={data.poolHelp}
      modelScope={scope} onModelScopeClear={() => setScope(null)} onModelOpen={openModel} onTaskOpen={openTask} filter={filter} onFilterChange={setFilter} />
    {children}
    {detail?.kind === "task" && <UnifiedTaskEditor key={`${detail.key}:${detail.attachConnectionId ?? ""}`} taskKey={detail.key} editor={data.editor}
      devices={data.devices} lockReason={data.lockReason} poolHelp={data.poolHelp} onClose={close} attachConnectionId={detail.attachConnectionId}
      row={data.assignments.rows.find(row => row.key === detail.key) ?? null} onModelOpen={openModel} />}
  </div>;
}
