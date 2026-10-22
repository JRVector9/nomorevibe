"use client";

import { useTranslations } from "@/lib/i18n/context";
/* eslint-disable @next/next/no-img-element -- 미리보기와 같은 내부 보관 이미지를 원래 비율로 보여 준다. */
import { useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/home/icons";
import { trackAttrs } from "@/lib/analytics/attrs";

export function PreviewImageDialog({ src, width, height, caption, children }: {
  src: string;
  width: number;
  height: number;
  caption: string;
  children: ReactNode;
}) {
  const t = useTranslations("detail");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  function open() {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }

  function close() {
    dialog.current?.close();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        {...trackAttrs("select_content", { content_type: "dialog", content_id: "preview_image" })}
        aria-haspopup="dialog"
        aria-controls={id}
        aria-label={t("preview.expand", { caption })}
        onClick={open}
        className="block w-full rounded-[10px] text-left"
        style={{ cursor: "zoom-in" }}
      >
        {children}
      </button>
      <dialog
        ref={dialog}
        id={id}
        aria-labelledby={`${id}-title`}
        onClose={() => trigger.current?.focus({ preventScroll: true })}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        // 공통 dialog의 모바일 시트 규칙보다 우선해 이미지 전체가 화면 안에 들어오게 한다.
        style={{
          margin: "auto",
          width: "min(1200px, calc(100vw - 32px))",
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100dvh - 32px)",
          padding: 0,
          border: "1px solid var(--border)",
          borderRadius: 18,
          overflow: "hidden",
        }}
      >
        <div className="flex items-center justify-between gap-3 p-3">
          <h2 id={`${id}-title`} className="m-0 truncate text-[16px] font-semibold leading-6">{t("preview.title")}</h2>
          <button
            type="button"
            onClick={close}
            aria-label={t("action.close")}
            className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-bg-soft text-fg-2 hover:text-fg"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="px-3 pb-3">
          <img
            src={src}
            width={width}
            height={height}
            alt={caption}
            loading="lazy"
            className="mx-auto block h-auto w-auto max-w-full rounded-[10px] object-contain"
            style={{ maxHeight: "max(1px, calc(100dvh - 36px - 5rem))" }}
          />
        </div>
      </dialog>
    </>
  );
}
