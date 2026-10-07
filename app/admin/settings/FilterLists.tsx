"use client";

import { useState } from "react";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { LIST_KEYS, missingDefaults, type ListKey } from "./model";
import { buttonClass, buttonGhost, buttonSmall, chipClass, hintClass, inputBase, inputClass, SettingsCard } from "./Switch";


const LISTS: Record<ListKey, { name: string; hint: string; placeholder: string }> = {
  blockedHomepageDomains: { name: "차단 도메인", placeholder: "예: pypi.org — 하위 도메인도 함께 걸립니다",
    hint: "배포 주소가 이 도메인이면 제품이 아니라 소개·등록 페이지로 봅니다(npm 패키지 페이지, GitHub 저장소 등)." },
  thirdPartyHosts: { name: "남의 사이트", placeholder: "예: substack.com — 주소 뒤쪽이 일치하면 걸립니다",
    hint: "제작자가 만든 곳이 아니라 남의 서비스에 올려 둔 글·초대·양식인 주소입니다. 그 주소는 제품이 아니라 제품 이야기입니다." },
  stubPageTitles: { name: "빈 페이지 제목", placeholder: "예: coming soon — * 를 쓸 수 있습니다",
    hint: "열어 봤더니 로그인 화면·공사 중 안내·404 인 경우를 제목으로 거릅니다. 주소는 살아 있어도 쓸 수 있는 것이 없는 경우입니다." },
  excludedRepoPatterns: { name: "레포명 제외", placeholder: "예: *-dotfiles — * 를 쓸 수 있습니다",
    hint: "레포 이름이 이 모양이면 제품이 아니라고 봅니다. 이력·포트폴리오·개인 홈페이지는 거부하지 않고 개인프로필로 발행됩니다." },
  heldRepoPatterns: { name: "레포명 보류", placeholder: "예: awesome-*",
    hint: "이름만으로는 못 가르는 모양입니다 — 거부하지 않고 보류해 AI·사람이 페이지를 읽고 가릅니다(회사 소개 사이트인지 앱 사이트인지 등)." },
};

const pill = "inline-flex h-[30px] items-center gap-1 rounded-lg border pl-[11px] pr-1 font-mono text-[13px]";
const pillButton = "inline-flex h-6 w-6 items-center justify-center rounded-md text-[15px] leading-none text-fg-3 hover:bg-bg-hover hover:text-fg";

export function FilterLists({ judge }: { judge: CrawlSettings["judge"] }) {
  const [lists, setLists] = useState<Record<ListKey, string[]>>(() =>
    Object.fromEntries(LIST_KEYS.map((key) => [key, [...judge[key]]])) as Record<ListKey, string[]>);
  const [tab, setTab] = useState<ListKey>("blockedHomepageDomains");
  const [draft, setDraft] = useState("");
  const [bulk, setBulk] = useState(false);
  const items = lists[tab];
  const missing = missingDefaults(tab, items);
  const drifted = LIST_KEYS.filter((key) => missingDefaults(key, lists[key]).length > 0).length;

  const update = (key: ListKey, next: string[]) => setLists((current) => ({ ...current, [key]: [...new Set(next.map((item) => item.trim()).filter(Boolean))] }));
  const add = () => { if (draft.trim()) update(tab, [...items, ...draft.split("\n")]); setDraft(""); };

  return (
    <SettingsCard id="lists" title="거르는 목록" note="주소·제목·레포 이름으로 제품이 아닌 것을 거릅니다"
      actions={drifted > 0 && <span className={`${chipClass} bg-warn/10 text-warn`}>기본값과 다름 {drifted}</span>}>
      {/* 다섯 목록을 늘 함께 보낸다 — 보이지 않는 탭의 목록도 저장에서 빠지면 안 된다 */}
      {LIST_KEYS.map((key) => <textarea key={key} name={key} value={lists[key].join("\n")} readOnly hidden />)}

      <div role="tablist" aria-label="거르는 목록" className="flex flex-wrap gap-x-4 border-b border-line">
        {LIST_KEYS.map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            onClick={() => { setTab(key); setBulk(false); setDraft(""); }}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2.5 pt-2 text-[14px] font-semibold ${tab === key ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg-2"}`}>
            {LISTS[key].name}
            <span className="rounded-full bg-bg-hover px-2 text-[13px] text-fg-3">{lists[key].length}</span>
            {missingDefaults(key, lists[key]).length > 0 && <span className="text-warn" aria-label="기본값과 다름">●</span>}
          </button>
        ))}
      </div>

      <p className={`${hintClass} max-w-[72ch]`}>{LISTS[tab].hint}</p>

      {missing.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-warn/25 bg-warn/5 px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[13px] font-semibold text-warn">코드 기본값에 있는데 저장된 목록에 없는 {missing.length}개</span>
            <button type="button" className={`${buttonSmall} ml-auto`} onClick={() => update(tab, [...items, ...missing])}>모두 더하기</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {missing.map((item) => (
              <span key={item} className={`${pill} border-dashed border-warn/40 bg-bg-card text-warn`}>{item}
                <button type="button" className={pillButton} aria-label={`${item} 더하기`} onClick={() => update(tab, [...items, item])}>+</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {bulk ? (
        <textarea aria-label={`${LISTS[tab].name} 한 줄에 하나`} rows={Math.min(14, Math.max(6, items.length + 1))}
          defaultValue={items.join("\n")} onChange={(event) => update(tab, event.target.value.split("\n"))}
          className={`${inputClass} font-mono text-[13px]`} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className={`${pill} border-line bg-bg-soft`}>{item}
              <button type="button" className={pillButton} aria-label={`${item} 빼기`} onClick={() => update(tab, items.filter((other) => other !== item))}>×</button>
            </span>
          ))}
          {items.length === 0 && <span className={hintClass}>비어 있습니다.</span>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!bulk && <>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`${LISTS[tab].name}에 더하기`}
            // 입력칸의 Enter 가 설정 전체를 저장하지 않게 — 여기서는 항목을 더한다
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
            placeholder={LISTS[tab].placeholder} className={`${inputBase} min-w-0 flex-[1_1_260px] font-mono text-[13px]`} />
          <button type="button" className={buttonClass} onClick={add}>더하기</button>
        </>}
        <button type="button" className={buttonGhost} onClick={() => setBulk((on) => !on)}>
          {bulk ? "칩으로 보기" : "한 번에 붙여넣기·고치기"}
        </button>
      </div>
    </SettingsCard>
  );
}
