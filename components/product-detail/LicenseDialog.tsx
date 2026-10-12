"use client";

import { useEffect, useId, useRef } from "react";
import { Icon } from "@/components/home/icons";
import type { LicensePresentation, LicenseValue } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";
import { GITHUB_LICENSE_GUIDE_URL, LICENSE_GUIDE } from "./license-guide";

function LicenseSource({ value, observed }: { value: LicenseValue; observed: boolean }) {
  const spdx = value.spdxId?.trim();
  const identified = Boolean(spdx && spdx !== "NOASSERTION" && spdx !== "NONE");
  const url = safeExternalUrl(value.url);
  const github = observed && value.sourceLabel.includes("GitHub");

  return (
    <div className="min-w-0 rounded-[10px] border border-line p-3">
      <p className="m-0 text-[13px] text-fg-2">{github ? "GitHub 자동 판별 · 저장소 대표 라이선스" : value.sourceLabel}</p>
      <p className="m-0 mt-1 break-words font-semibold">{identified ? spdx : value.value}</p>
      {!identified && <p className="m-0 mt-1 text-[13px] text-fg-2">SPDX 미확인 · 원문 확인 필요</p>}
      {url && <p className="m-0 mt-2 text-[13px]"><a href={url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">제공된 라이선스 정보 ↗</a></p>}
    </div>
  );
}

export function LicenseDialog({ license, source, repositoryUrl, label }: {
  license: LicensePresentation;
  source: { state: string; lastSuccess: string; lastFailure: string } | null;
  repositoryUrl: string | null;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreScroll = useRef<(() => void) | null>(null);
  const id = useId();
  const unidentifiedLicense = license.state === "unidentified";
  const sourceStatus = source?.state === "disconnected" ? "연결 끊김"
    : source?.state === "failed" ? "최근 갱신 실패"
      : source?.state === "stale" ? "갱신 지연"
        : source?.state === "unobserved" ? "수집 미완료" : "관측 시점의 정보";

  useEffect(() => () => { restoreScroll.current?.(); }, []);

  function unlockScroll() {
    const restore = restoreScroll.current;
    restoreScroll.current = null;
    restore?.();
  }

  function open() {
    const node = dialog.current;
    if (!node || node.open) return;
    node.showModal();
    if (restoreScroll.current) return;
    const restorers = [document.documentElement.style, document.body.style].map((style) => {
      const previous = ["overflow-x", "overflow-y"].map((property) => ({
        property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property),
      }));
      for (const { property } of previous) style.setProperty(property, "hidden", "important");
      return () => {
        for (const { property, value, priority } of previous) style.setProperty(property, value, priority);
      };
    });
    restoreScroll.current = () => { for (const restore of restorers) restore(); };
  }

  function close() {
    dialog.current?.close();
    unlockScroll();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-controls={id}
        aria-label={`라이선스 ${label} 안내 보기`}
        onClick={open}
        className="max-w-full cursor-pointer truncate rounded-sm text-left underline decoration-line underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-ink"
      >
        {label}<span aria-hidden className="ml-1 text-[13px] font-normal text-fg-2">ⓘ</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-summary`}
        onClose={(event) => {
          if (event.currentTarget.open) return;
          unlockScroll();
          trigger.current?.focus({ preventScroll: true });
        }}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className="whitespace-normal text-[14px] font-normal leading-relaxed tracking-normal"
        style={{ margin: "auto", width: "min(960px, calc(100vw - 24px))", maxWidth: "calc(100vw - 24px)", maxHeight: "calc(100dvh - 24px)", overflow: "hidden", padding: 0 }}
      >
        <div className="flex max-h-[calc(100dvh-26px)] flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`${id}-title`} className="m-0 text-[18px] font-semibold">라이선스 안내</h2>
            <button type="button" onClick={close} aria-label="닫기" className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-bg-soft text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink"><Icon name="close" /></button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
            <p id={`${id}-summary`} className="m-0 text-[13px] text-fg-2">주요 라이선스 조건의 요약입니다. 실제 이용 조건은 저장소의 LICENSE와 파일별 고지·추가 조건을 확인하세요.</p>
            <h3 className="mb-2 mt-5 text-[15px] font-semibold">이 제품에 표시된 정보</h3>
            {license.state === "conflict" && <p className="mb-3 mt-0 text-[13px] text-down">메이커 선언과 저장소 관측이 다릅니다. 어느 조건이 적용되는지 원문 확인이 필요합니다.</p>}
            {license.state === "maker_only" && <p className="mb-3 mt-0 text-[13px] text-fg-2">메이커가 제공한 정보이며 저장소에서 확인되지 않았습니다.</p>}
            {unidentifiedLicense && <p className="mb-3 mt-0 text-[13px] text-fg-2">저장소 라이선스를 식별하지 못했습니다. 자동 판별 실패는 이용 허락을 뜻하지 않으며 메이커 선언도 별도 확인이 필요합니다.</p>}
            {license.state === "missing" && <p className="mb-3 mt-0 text-[13px] text-fg-2">라이선스를 확인하지 못했습니다. 공개 저장소라는 이유만으로 재사용이 허용되지는 않습니다.</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {license.observed && <LicenseSource value={license.observed} observed />}
              {license.maker && <LicenseSource value={license.maker} observed={false} />}
            </div>
            {license.observed && <p className="mb-0 mt-2 text-[13px] text-fg-2">저장소 관측은 파일별 조건·복수 라이선스·의존성 전체를 확인한 결과가 아닙니다.</p>}
            {license.observed && source && <p className="mb-0 mt-2 text-[13px] text-fg-2">{sourceStatus}{source.lastSuccess && ` · 마지막 수집 성공 ${source.lastSuccess}`}{source.lastFailure && ` · 마지막 수집 실패 ${source.lastFailure}`} (한국 시각)</p>}
            {repositoryUrl && <p className="mb-0 mt-2 text-[13px]"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">저장소에서 LICENSE 확인 ↗</a></p>}
            <h3 id={`${id}-table-title`} className="mb-2 mt-6 text-[15px] font-semibold">주요 라이선스 비교</h3>
            <p className="mb-3 mt-0 text-[13px] text-fg-2">표에 나온 라이선스는 각 조건을 지키면 상용 이용이 가능합니다. 복수·커스텀·미확인 라이선스의 허용 범위는 원문을 확인해야 합니다. 좁은 화면에서는 표를 좌우로 밀어 볼 수 있습니다.</p>
            <div role="region" aria-labelledby={`${id}-table-title`} tabIndex={0} className="overflow-x-auto rounded-[10px] border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink">
              <table className="w-full min-w-[780px] border-collapse text-left text-[13px]">
                <caption className="sr-only">주요 라이선스의 상용 이용, 수정·재배포, 소스 제공 의무와 핵심 조건. 라이선스 이름은 공식 원문 링크입니다.</caption>
                <thead className="bg-bg-soft">
                  <tr>
                    {["라이선스 · 원문", "상용 이용", "수정·재배포", "소스 제공 의무", "핵심 조건"].map((title) => <th key={title} scope="col" className="border-b border-line px-3 py-2 font-semibold">{title}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {LICENSE_GUIDE.map((row) => (
                    <tr key={row.name} className="border-b border-line last:border-b-0">
                      <th scope="row" className="whitespace-nowrap px-3 py-3 align-top font-medium"><a href={row.url} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{row.name} ↗</a></th>
                      <td className="whitespace-nowrap px-3 py-3 align-top">{row.commercial}</td>
                      <td className="px-3 py-3 align-top">{row.redistribution}</td>
                      <td className="min-w-[180px] px-3 py-3 align-top">{row.source}</td>
                      <td className="min-w-[240px] px-3 py-3 align-top">{row.conditions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-0 mt-3 text-[13px] text-fg-2">GPL·LGPL·AGPL의 <code>-only</code>는 해당 버전만, <code>-or-later</code>는 해당 버전 또는 이후 버전을 선택할 수 있다는 뜻입니다. 버전과 접미사가 없는 표기만으로 이후 버전 허용을 판단하지 마세요. 소스 제공은 조건에 따른 수령인·이용자 대상이며 항상 인터넷 전체 공개를 뜻하지는 않습니다.</p>
            <p className="mb-0 mt-3 text-[13px]"><a href={GITHUB_LICENSE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">GitHub의 라이선스 판별·표시 안내 ↗</a></p>
          </div>
        </div>
      </dialog>
    </>
  );
}
