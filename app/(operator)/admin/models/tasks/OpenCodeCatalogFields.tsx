"use client";

import { useEffect, useState } from "react";
import { cliCatalogMetadata, type CliCatalogMetadata } from "@/lib/llm/cli-catalog-metadata";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";

const cached = new Map<string, CliCatalogMetadata>();
const pending = new Map<string, Promise<CliCatalogMetadata>>();
const fresh = (catalog: CliCatalogMetadata | null) => !!catalog && Date.parse(catalog.observedAt) + 60_000 > Date.now();
function readCatalog(connectionId?: string, refresh = false): Promise<CliCatalogMetadata> {
  const key = connectionId ?? "default";
  const hit = cached.get(key);
  if (!refresh && fresh(hit ?? null)) return Promise.resolve(hit!);
  const active = pending.get(key);
  if (active) return active;
  const params = new URLSearchParams();
  if (connectionId) params.set("connectionId", connectionId);
  if (refresh) params.set("refresh", "1");
  const query = params.size ? `?${params}` : "";
  const reading = fetch(`/admin/models/tasks/cli-catalog${query}`, { cache: "no-store", credentials: "same-origin" }).then(async response => {
    if (!response.ok) throw new Error("unavailable");
    const body = await response.json();
    const catalog = cliCatalogMetadata(body?.catalog);
    if (!body?.ok || !catalog || !fresh(catalog)) throw new Error("unavailable");
    cached.set(key, catalog);
    return catalog;
  }).finally(() => { pending.delete(key); });
  pending.set(key, reading);
  return reading;
}

/** The existing M3 user's authenticated providers define this list; nothing is installed or called for inference. */
export function OpenCodeCatalogFields({ initial, onReady }: { initial: AiConnectionView | null; onReady: (ready: boolean) => void }) {
  const [catalog, setCatalog] = useState<CliCatalogMetadata | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    readCatalog(initial?.id, attempt > 0).then(value => {
      if (!active) return;
      setCatalog(value); setState("ready"); onReady(true);
    }).catch(() => {
      if (!active) return;
      setCatalog(null); setState("error"); onReady(false);
    });
    return () => { active = false; };
  }, [attempt, initial?.id, onReady]);
  const models = catalog?.models.map(model => model.id) ?? initial?.cliModels ?? [];
  const version = catalog?.cliVersion ?? initial?.cliVersion ?? "";
  return <div className="grid min-w-0 gap-2" aria-label="M3 OpenCode 실제 모델 목록" aria-busy={state === "loading"}>
    <input type="hidden" name="cliModels" value={models.join(" ")} />
    <input type="hidden" name="cliVersion" value={version} />
    {state === "loading" && <p role="status" className="text-[13px] text-fg-3">M3의 기존 OpenCode 모델 목록을 읽는 중…</p>}
    {state === "error" && <p role="status" className="text-[13px] text-amber-700">M3 OpenCode에 연결하지 못했습니다. 마지막 저장된 모델 {models.length}개만 표시합니다. 연결을 확인한 뒤 다시 조회하세요.</p>}
    {state === "error" && initial?.enabled && <p className="text-[13px] text-fg-3">기존 연결을 끄는 저장은 가능합니다. 이때 모델·버전·추론 목록은 마지막 저장값을 유지합니다.</p>}
    <p className="text-[13px]">{catalog ? `M3 OpenCode ${version} · 실제 제공 모델 ${models.length}개` : version ? `마지막 저장 버전 ${version}` : "M3 OpenCode 버전 미확인"}</p>
    {initial && <p className="text-[13px] text-fg-3">{initial.hasKey ? "호스트 RPC 인증 정보 저장됨" : "호스트 RPC 인증 정보 미확인"}</p>}
    {(catalog?.observedAt ?? initial?.cliCatalog?.observedAt) && <p className="text-[13px] text-fg-3">{catalog ? "목록 관측" : "마지막 저장 관측"} {new Date(catalog?.observedAt ?? initial!.cliCatalog!.observedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} KST</p>}
    <details className="min-w-0">
      <summary className="cursor-pointer text-[13px]">{catalog ? "실제 제공 모델" : "마지막 저장된 모델"} {models.length}개 보기</summary>
      <ul className="mt-2 grid max-h-64 gap-2 overflow-y-auto rounded border border-line p-2 text-[13px]">
        {models.map(id => { const model = catalog?.models.find(entry => entry.id === id); return <li key={id} className="break-words">
          <code className="break-all">{id}</code>
          {model && <span className="text-fg-3"> · 추론 {model.variants.length ? model.variants.join(" · ") : "기본값"}</span>}
        </li>; })}
        {!models.length && <li className="text-fg-3">저장된 모델이 없습니다.</li>}
      </ul>
    </details>
    <p className="text-[13px] text-fg-3">연결을 저장하면 이 실제 목록을 작업별 모델 선택에 사용합니다. 추론 강도는 작업의 순위 선택에서 고릅니다. 목록 조회는 모델 호출 성공을 뜻하지 않습니다.</p>
    <button type="button" disabled={state === "loading"} className="justify-self-start rounded border border-line px-2 py-1 text-[13px] disabled:opacity-50"
      onClick={() => { setState("loading"); onReady(false); setAttempt(value => value + 1); }}>목록 다시 조회</button>
  </div>;
}
