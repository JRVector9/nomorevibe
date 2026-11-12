type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS: Readonly<Record<string, string>> = { modes: "tasks", connections: "models", "assist-fold": "assist-controls", "limits-fold": "concurrency", "cleanup-fold": "cleanup" };
export const unifiedSectionHash = (hash: string) => { const id = hash.replace(/^#/, ""); return `#${SECTIONS[id] ?? id}`; };

/** 서버에는 오지 않는 옛 조각 주소도 브라우저에서 그대로 새 통합 화면으로 옮긴다. */
export function legacyTasksHref(params: Params = {}, hash = ""): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // 옛 tasks/page는 edit·import만 읽었다. tab은 /models의 옛 대시보드 라우터 값이므로 다시 전달해 통합 화면을 이탈시키지 않는다.
    if (["edit", "id", "tab"].includes(key)) continue;
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const connection = one(params.model) || one(params.edit) || (UUID.test(one(params.id)) ? one(params.id) : "");
  if (connection) query.set("model", connection);
  const taskId = !connection ? one(params.task) || one(params.id) : "";
  if (taskId && /^[a-z][a-z0-9-]*(?:#[1-9][0-9]*)?$/.test(taskId)) query.set("task", taskId.includes("#") ? taskId : `${taskId}#1`);
  let fragment = hash.replace(/^#/, "");
  if (!fragment) {
    const mode = one(params.mode);
    fragment = connection ? "model-detail" : one(params.import) === "plan" ? "import"
      : query.has("task") ? `execution-${query.get("task")!.replace("#", "-")}`
        : mode.startsWith("mode-") ? mode : mode.includes("#") ? `mode-${mode.replace("#", "-")}`
          : /^[a-z][a-z0-9-]*$/.test(mode) && !["fallback", "workload_pool"].includes(mode) ? `mode-${mode}-1` : "tasks";
  }
  if (fragment.startsWith("conn-")) {
    query.set("model", fragment.slice(5));
    fragment = "model-detail";
  }
  return `/admin/models${query.size ? `?${query}` : ""}${unifiedSectionHash(fragment)}`;
}

/** 옛 실행 방식·순위 줄과 새 ?task= 주소는 모두 같은 공유 작업 편집기를 연다. */
export function unifiedTaskKey(hash: string, keys: readonly string[]): string | null {
  let fragment: string;
  try { fragment = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  return keys.find(key => {
    const [task, slot] = key.split("#");
    return fragment === key || fragment === `execution-${task}-${slot}` || fragment === `mode-${task}-${slot}`;
  }) ?? null;
}
