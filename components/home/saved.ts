import { SAVED_LIMIT } from "@/lib/me/contract";
import { loadMeState, meStateSnapshot, subscribeMeState } from "@/components/me/account-store";

const KEY = "nmb-saved-v1";
/** 로그인한 계정과 맞춰 본 기록 — 마지막으로 본 서버 주소(base)와 아직 서버에 못 보낸 바꿈(pending) */
const SYNC_KEY = "nmb-saved-sync-v1";
/** 합치기에 «나중에»를 고른 계정 id */
const LATER_KEY = "nmb-saved-merge-later-v1";
const ACCOUNT_EVENT = "nmb:saved-account-changed";

export function savedSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function parseSaved(raw: string): Set<string> {
  try {
    const value = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function subscribeSaved(onStoreChange: () => void): () => void {
  startSavedSync();
  window.addEventListener("nmb:saved-changed", onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener("nmb:saved-changed", onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function persistSaved(saved: Set<string>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([...saved]));
    window.dispatchEvent(new Event("nmb:saved-changed"));
    return true;
  } catch {
    return false;
  }
}

/* ── 계정과 맞춰 보기(로그인 설계 L4) — 순수 함수 ── */

export type SavedOp = "put" | "delete";
export type SavedSyncState = {
  user: number; base: string[]; pending: Record<string, SavedOp>;
  /** base 를 받을 때 본 저장 판(account-store savedVersion) — 다음 화면에서 판이 같으면 계정 목록을 다시 받지 않는다 */
  version?: string;
};

/**
 * 이 브라우저 목록(local)을 계정 목록(server)에 맞춘다. 로그인한 사람에게는 서버가 기준이다.
 * - 아직 못 보낸 바꿈(pending)은 지키고 다시 보낸다 — fenced DB 로 실패한 저장·빼기를 잃지 않는다.
 * - 지난번 서버에 있었는데(base) 지금 없으면 다른 기기에서 뺀 것이라 여기서도 뺀다.
 * - 서버에 없고 base 에도 없으면 이 브라우저에서만 저장한 것(localOnly) — 계정으로 옮길지 묻는다.
 * - 서버에만 있는 것은 더한다(다른 기기에서 저장).
 */
export function reconcileSaved({ local, server, base, pending }: {
  local: readonly string[]; server: readonly string[]; base: readonly string[]; pending: Readonly<Record<string, SavedOp>>;
}): { local: string[]; base: string[]; pending: Record<string, SavedOp>; puts: string[]; deletes: string[]; localOnly: string[] } {
  const onServer = new Set(server), known = new Set(base);
  const next: Record<string, SavedOp> = {};
  for (const [slug, op] of Object.entries(pending)) {
    if (op === "put" ? !onServer.has(slug) : onServer.has(slug)) next[slug] = op;
  }
  const kept = local.filter((slug) => next[slug] !== "delete" && (onServer.has(slug) || next[slug] === "put" || !known.has(slug)));
  // 브라우저 목록은 오래된 것 먼저 — 서버(최근 먼저)에만 있는 것은 뒤집어 붙인다
  const added = [...server].reverse().filter((slug) => next[slug] !== "delete");
  const puts = Object.keys(next).filter((slug) => next[slug] === "put");
  return {
    local: [...new Set([...kept, ...added, ...puts])],
    base: [...new Set(server)],
    pending: next,
    puts,
    deletes: Object.keys(next).filter((slug) => next[slug] === "delete"),
    localOnly: kept.filter((slug) => !onServer.has(slug) && !next[slug]),
  };
}

/** 로그아웃·계정 바뀜 — 계정에서 내려받은 사본은 지우고(공용 PC), 서버에 못 보낸 저장만 이 브라우저 것으로 남긴다 */
export function forgetAccountCopy(local: readonly string[], state: SavedSyncState): string[] {
  const base = new Set(state.base);
  return local.filter((slug) => !base.has(slug) || state.pending[slug] === "put");
}

/* ── 브라우저 쪽 동기화 — 문서마다 한 번 계정과 맞추고(저장 판이 그대로면 목록은 받지 않는다), 로그인 중 책갈피는 서버에도 쓴다 ── */

export type SavedNotice = { kind: "merged"; merged: number; skipped: number } | { kind: "mergeFailed" } | { kind: "limit" } | { kind: "unavailable" };
export type SavedAccount = {
  /** user 일 때만 서버와 맞춘다. none 이면 이 브라우저 목록만(지금까지와 같다) */
  status: "checking" | "none" | "user";
  userId: number | null;
  /** 계정의 공개 저장 수 — 머리 책갈피 점이 쓴다. 못 받았으면 null */
  serverCount: number | null;
  /** 계정으로 옮길지 물을 이 브라우저 저장 수 — «나중에»를 골랐으면 0 */
  offer: number;
  notice: SavedNotice | null;
};

const INITIAL: SavedAccount = { status: "checking", userId: null, serverCount: null, offer: 0, notice: null };
let account = INITIAL;
/**
 * offline: 계정을 묻지 못했다 — 바꿈은 지난 계정 기록(없으면 early)에 쌓아 두고, 로그인 상태를 받으면 다시 맞춰 보낸다.
 * none: 로그아웃·로그인 꺼짐 — 이 브라우저 목록만. 다른 탭에서 로그인한 것이 확인되면 다시 맞춘다
 */
let phase: "idle" | "checking" | "none" | "offline" | "user" = "idle";
let csrf = "";
let offerSlugs: string[] = [];
/** 계정을 확인하기 전에 누른 바꿈 — 로그인이 확인되면 pending 으로 옮겨 보낸다 */
const early = new Map<string, SavedOp>();
const chains = new Map<string, Promise<void>>();
/** 합치기 중 — 그사이 누른 넣기·빼기는 합치기가 끝난 뒤 보낸다(늦게 끝난 합치기가 방금 뺀 것을 다시 넣지 않게) */
let merging: Promise<unknown> | null = null;
/** 이 브라우저의 저장·빼기와 그 보내기가 끝날 때마다 하나 늘린다 — 계정 목록을 받는 사이 바뀌었는지 본다 */
let edits = 0;
/** 받는 사이 바뀌면 보내기가 끝난 뒤 다시 받는다 — 계속 바뀌면 이만큼만 */
const REFRESH_TRIES = 3;

function setAccount(patch: Partial<SavedAccount>): void {
  account = { ...account, ...patch };
  window.dispatchEvent(new Event(ACCOUNT_EVENT));
}

export const savedAccountSnapshot = (): SavedAccount => account;
export const savedAccountServerSnapshot = (): SavedAccount => INITIAL;
export function subscribeSavedAccount(onChange: () => void): () => void {
  startSavedSync();
  window.addEventListener(ACCOUNT_EVENT, onChange);
  return () => window.removeEventListener(ACCOUNT_EVENT, onChange);
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** 저장소를 못 쓰는 브라우저(저장소를 끈 WebView·용량 초과) — 마지막 쓰기가 실패했으면 이 문서 안에서는 이 사본으로 맞춘다 */
let syncCopy: SavedSyncState | null = null;
let syncStored = true;

function readSync(): SavedSyncState | null {
  const value = (syncStored ? readJson(SYNC_KEY) : syncCopy) as Partial<SavedSyncState> | null;
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.user)) return null;
  const pending: Record<string, SavedOp> = {};
  if (value.pending && typeof value.pending === "object") {
    for (const [slug, op] of Object.entries(value.pending)) if (op === "put" || op === "delete") pending[slug] = op;
  }
  return { user: value.user!, base: strings(value.base), pending, ...(typeof value.version === "string" ? { version: value.version } : {}) };
}

function writeSync(value: SavedSyncState | null): void {
  syncCopy = value;
  syncStored = writeJson(SYNC_KEY, value);
}

const localList = (): string[] => [...parseSaved(savedSnapshot())];
function writeLocal(list: string[]): void {
  if (JSON.stringify(list) !== savedSnapshot()) persistSaved(new Set(list));
}
function postponed(userId: number): boolean {
  const later = readJson(LATER_KEY);
  return Array.isArray(later) && later.includes(userId);
}

/** 문서마다 한 번 — 저장을 그리는 첫 구독이 부른다 */
export function startSavedSync(): void {
  if (phase !== "idle" || typeof window === "undefined") return;
  phase = "checking";
  // 처음에 묻지 못했거나(503·끊김) 다른 탭에서 로그인했으면, 로그인 상태를 새로 받을 때 다시 맞춘다
  subscribeMeState(() => {
    const me = meStateSnapshot();
    if (!me || me.status === "error" || !(phase === "offline" || (phase === "none" && me.account))) return;
    phase = "checking";
    void connect();
  });
  void connect();
}

async function connect(): Promise<void> {
  // 머리 메뉴·종과 같은 한 번의 로그인 물음을 나눠 쓴다. off = 로그인 기능이 꺼져 있다 — 이 브라우저 목록만
  const loaded = await loadMeState();
  const me = loaded.account;
  const state = readSync();
  if (!me) {
    if (loaded.status === "error") {
      // 묻지 못했다 — 로그아웃으로 보지 않는다. 바꿈은 지난 계정 기록(없으면 early)에 쌓아 두고, 답을 받으면 다시 맞춘다
      phase = "offline";
      if (state && early.size) {
        for (const [slug, op] of early) state.pending[slug] = op;
        early.clear();
        writeSync(state);
      }
    } else {
      phase = "none";
      early.clear();
      if (loaded.status === "ok" && state) {
        writeLocal(forgetAccountCopy(localList(), state));
        writeSync(null);
      }
    }
    setAccount({ status: "none" });
    return;
  }
  csrf = me.csrfToken;
  const userId = me.user.id;
  let current = state;
  if (state && state.user !== userId) {
    writeLocal(forgetAccountCopy(localList(), state));
    current = null;
  }
  current ??= { user: userId, base: [], pending: {} };
  for (const [slug, op] of early) current.pending[slug] = op;
  early.clear();
  writeSync(current);
  phase = "user";
  setAccount({ status: "user", userId });
  // 지난번 맞춘 뒤 계정 목록이 그대로면(판이 같고, 못 보낸 바꿈이 없고, 받은 것이 이 브라우저에 다 있다) 다시 받지 않는다
  const local = localList(), known = new Set(current.base), here = new Set(local);
  if (me.savedVersion && current.version === me.savedVersion && !Object.keys(current.pending).length && current.base.every((slug) => here.has(slug))) {
    offerSlugs = local.filter((slug) => !known.has(slug));
    setAccount({ serverCount: current.base.length, offer: postponed(userId) ? 0 : offerSlugs.length });
    return;
  }
  await refresh(me.savedVersion);
}

/**
 * 계정 목록을 받아 이 브라우저와 맞춘다. 못 받으면(fenced DB·끊김) 이 브라우저 목록을 그대로 둔다.
 * 받는 사이 저장·빼기를 했거나 보내기가 끝났으면 받은 목록은 그 전의 것이다 — 맞추면 방금 한 일을 되돌린다.
 * 그 목록은 버리고 보내기가 모두 끝난 뒤 다시 받는다.
 */
async function refresh(version?: string | null): Promise<void> {
  let server: string[] | null = null;
  for (let attempt = 0; attempt < REFRESH_TRIES && server === null; attempt += 1) {
    const since = edits;
    try {
      const response = await fetch("/api/me/saved?view=slugs", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      server = strings((await response.json() as { slugs?: unknown }).slugs);
    } catch {
      return;
    }
    if (edits !== since) {
      server = null;
      await Promise.allSettled([...chains.values()]);
    }
  }
  if (server === null) return;
  const state = readSync();
  if (!state || state.user !== account.userId) return;
  const result = reconcileSaved({ local: localList(), server, base: state.base, pending: state.pending });
  writeLocal(result.local);
  // 판은 받기 전에 본 것만 남긴다 — 그 뒤 바뀌었으면 다음 화면에서 판이 달라 다시 받는다
  writeSync({ user: state.user, base: result.base, pending: result.pending, ...(version ? { version } : {}) });
  offerSlugs = result.localOnly;
  setAccount({ serverCount: result.base.length, offer: postponed(state.user) ? 0 : offerSlugs.length });
  for (const slug of result.puts) send(slug, "put");
  for (const slug of result.deletes) send(slug, "delete");
}

function queue(slug: string, op: SavedOp): void {
  edits += 1;
  if (phase === "none") return;
  const state = phase === "user" || phase === "offline" ? readSync() : null;
  if (state) {
    state.pending[slug] = op;
    writeSync(state);
  } else early.set(slug, op);
  if (phase === "user" && state) send(slug, op);
  // 묻지 못했으면 누를 때 다시 묻는다 — 답을 받으면 다시 맞추며 보낸다
  else if (phase === "offline") void loadMeState();
}

/** 같은 주소의 바꿈은 한 줄로 보낸다 — 빨리 눌러도 마지막 뜻이 서버에 남는다. 합치기 중이면 그 뒤에 */
function send(slug: string, op: SavedOp): void {
  chains.set(slug, (chains.get(slug) ?? Promise.resolve()).then(() => merging).then(() => deliver(slug, op)));
}

async function deliver(slug: string, op: SavedOp): Promise<void> {
  if (readSync()?.pending[slug] !== op) return;
  let response: Response;
  try {
    response = await fetch(`/api/me/saved/${encodeURIComponent(slug)}`, { method: op === "put" ? "PUT" : "DELETE", headers: { "x-csrf-token": csrf } });
  } catch {
    return;
  }
  const code = response.ok ? null : await response.json().then((body: { error?: unknown }) => body.error, () => null);
  // 받지 않은 것(내려간 제품·잘못된 주소·상한·로그인 꺼짐)만 거둔다. 그 밖의 실패(503·429·401)는 pending 으로 남겨 다음 방문에 다시 보낸다
  const settled = response.ok || response.status === 400 || response.status === 404 || code === "saved_limit";
  const state = readSync();
  if (!settled || !state || state.user !== account.userId) return;
  edits += 1;
  if (state.pending[slug] === op) delete state.pending[slug];
  if (response.ok) state.base = op === "put" ? [slug, ...state.base.filter((item) => item !== slug)] : state.base.filter((item) => item !== slug);
  writeSync(state);
  // 계정이 받지 않은 저장(상한·목록에 없는 제품)은 이 브라우저에서도 되돌리고 알린다 — 남겨 두면 옮길 거리로 묻고 합치기에서 말없이 빠진다
  const refused = op === "put" ? code === "saved_limit" ? "limit" as const : code === "product_not_found" ? "unavailable" as const : null : null;
  if (refused) {
    const local = parseSaved(savedSnapshot());
    local.delete(slug);
    persistSaved(local);
  }
  offerSlugs = offerSlugs.filter((item) => item !== slug);
  setAccount({
    serverCount: state.base.length,
    offer: account.offer ? offerSlugs.length : 0,
    ...(refused ? { notice: { kind: refused } } : {}),
  });
}

/** 책갈피 — 이 브라우저에 바로 쓰고, 로그인 중이면 서버에도 쓴다. 저장된 상태를 돌려준다 */
export function toggleSaved(slug: string, on?: boolean): boolean {
  const saved = parseSaved(savedSnapshot());
  const next = on ?? !saved.has(slug);
  if (saved.has(slug) !== next) {
    if (next) saved.add(slug);
    else saved.delete(slug);
    persistSaved(saved);
  }
  queue(slug, next ? "put" : "delete");
  return next;
}

/**
 * 이 브라우저에만 있는 저장을 계정으로 옮긴다(L4). 옮긴 수·건너뛴 수는 notice 로 알린다.
 * 한 번에 최근 것부터 SAVED_LIMIT 개 — 보내지 않은 것은 다음 맞추기에서 다시 옮길지 묻는다
 */
export async function mergeBrowserSaved(): Promise<boolean> {
  const state = readSync();
  if (phase !== "user" || !state || !offerSlugs.length || merging) return false;
  // 물은 뒤 이 브라우저에서 빼거나 따로 보낸 것(pending)은 옮기지 않는다
  const here = new Set(localList());
  const sent = offerSlugs.filter((slug) => here.has(slug) && !state.pending[slug]).slice(-SAVED_LIMIT);
  if (!sent.length) {
    offerSlugs = [];
    setAccount({ offer: 0 });
    return false;
  }
  const request = fetch("/api/me/saved", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ slugs: sent }),
  }).then((response) => response.ok ? response.json() as Promise<{ merged?: unknown; skipped?: unknown }> : null).catch(() => null);
  merging = request;
  let result: { merged?: unknown; skipped?: unknown } | null;
  try {
    result = await request;
  } finally {
    merging = null;
  }
  if (!result) {
    // fenced DB 면 이 브라우저 목록을 지우지 않는다 — 다음에 다시 묻는다
    setAccount({ notice: { kind: "mergeFailed" } });
    return false;
  }
  const done = readSync();
  if (!done || done.user !== state.user) return false;
  // 보낸 것은 건너뛴 것(내려간 제품·상한)까지 계정이 판단했다 — 다음 맞추기에서 이 브라우저에서도 빠진다.
  // 합치기 중에 누른 것(pending)은 그 바꿈이 정한다
  done.base = [...new Set([...done.base, ...sent.filter((slug) => !done.pending[slug])])];
  writeSync(done);
  offerSlugs = [];
  setAccount({ offer: 0, notice: { kind: "merged", merged: Number(result.merged) || 0, skipped: Number(result.skipped) || 0 } });
  await refresh();
  return true;
}

/** «나중에» — 이 계정에는 다시 묻지 않는다. 이 브라우저 목록은 그대로 둔다 */
export function postponeMerge(): void {
  if (account.userId === null) return;
  const later = readJson(LATER_KEY);
  writeJson(LATER_KEY, [...new Set([...(Array.isArray(later) ? later : []), account.userId])]);
  setAccount({ offer: 0 });
}

export function clearSavedNotice(): void {
  if (account.notice) setAccount({ notice: null });
}
