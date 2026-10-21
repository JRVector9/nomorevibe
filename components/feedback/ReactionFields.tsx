"use client";

import "./reaction.css";
import { useId, useRef, type RefObject } from "react";
import { useTranslations } from "@/lib/i18n/context";
import {
  REACTION_COMMENT_LIMIT, REACTION_TAG_LIMIT, REACTION_TAGS, REACTION_VERDICTS,
  type ReactionTag, type ReactionVerdict,
} from "@/lib/me/contract";

export type ReactionDraft = { verdict: ReactionVerdict; tags: ReactionTag[]; comment: string };

/** 한 줄은 코드 포인트로 센다 — 서버(varchar 140)와 같은 셈 */
export const commentLength = (value: string) => Array.from(value).length;

/** 칸마다 쓰는 me 열쇠 — 상세 판(try)은 tryPanelMessages 가 남기는 열쇠만 쓴다(tests/try-messages.test.ts) */
export const REACTION_FIELD_LABELS = {
  try: { verdicts: "try.verdicts", tags: "try.tags", comment: "try.comment", note: "try.note" },
  tried: { verdicts: "tried.verdict", tags: "tried.tags", comment: "tried.comment", note: "tried.publicNote" },
} as const;

/**
 * 한 줄 칸의 maxLength — 남은 코드 포인트만큼 UTF-16 칸을 더 받는다. 브라우저가 커서 자리에서 넘치는 입력·붙여넣기를 막는다
 * (뒤를 잘라 커서가 끝으로 튀지 않게). 이모지처럼 두 칸인 글자는 남은 자리보다 적게 들어갈 뿐 넘치지 않는다.
 */
export const commentMaxLength = (value: string) => value.length + Math.max(0, REACTION_COMMENT_LIMIT - commentLength(value));

/**
 * 평가·태그·한 줄 칸 — 상세 판(펼침·휴대폰 시트)과 마이페이지 고치기가 같은 규칙(태그 10개 중 4개, 140자)을 쓴다.
 * 숨은 칸(봇 미끼)은 화면과 읽기 도구에서 모두 숨긴다.
 */
export function ReactionFields({ draft, onChange, showVerdict = false, variant, trap }: {
  draft: ReactionDraft;
  onChange: (draft: ReactionDraft) => void;
  showVerdict?: boolean;
  variant: "try" | "tried";
  trap: RefObject<HTMLInputElement | null>;
}) {
  const t = useTranslations("me");
  const id = useId();
  const labels = REACTION_FIELD_LABELS[variant];
  // 한글 조합 중에는 값을 고쳐 쓰지 않는다 — 조합이 끝난 뒤 넘친 것만 자른다
  const composing = useRef(false);
  const setComment = (value: string) => onChange({
    ...draft, comment: composing.current || commentLength(value) <= REACTION_COMMENT_LIMIT ? value : Array.from(value).slice(0, REACTION_COMMENT_LIMIT).join(""),
  });
  const full = draft.tags.length >= REACTION_TAG_LIMIT;
  const toggle = (tag: ReactionTag) => {
    const tags = draft.tags.includes(tag) ? draft.tags.filter((item) => item !== tag) : full ? draft.tags : [...draft.tags, tag];
    onChange({ ...draft, tags: REACTION_TAGS.filter((item) => tags.includes(item)) });
  };
  return (
    <>
      {showVerdict && (
        <div className="reaction-verdicts" role="group" aria-label={t(labels.verdicts)}>
          {REACTION_VERDICTS.map((verdict) => (
            <button key={verdict} type="button" className="reaction-verdict" data-verdict={verdict} aria-pressed={draft.verdict === verdict}
              onClick={() => onChange({ ...draft, verdict })}>
              {t(`verdict.${verdict}`)}
            </button>
          ))}
        </div>
      )}
      <fieldset className="reaction-fieldset">
        <legend className="reaction-label">{t(labels.tags)}</legend>
        <div className="reaction-tags">
          {REACTION_TAGS.map((tag) => {
            const on = draft.tags.includes(tag);
            return (
              <button key={tag} type="button" className="reaction-tag" aria-pressed={on} disabled={!on && full} onClick={() => toggle(tag)}>
                {t(`tag.${tag}`)}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="reaction-fieldset">
        <div className="reaction-label-row">
          <label className="reaction-label" htmlFor={`${id}-comment`}>{t(labels.comment)}</label>
          <span className="reaction-count" aria-hidden="true">{t("try.count", { count: commentLength(draft.comment), limit: REACTION_COMMENT_LIMIT })}</span>
        </div>
        <input id={`${id}-comment`} className="reaction-input" type="text" value={draft.comment} autoComplete="off" enterKeyHint="send"
          aria-describedby={`${id}-note`} maxLength={commentMaxLength(draft.comment)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(event) => { composing.current = false; setComment(event.currentTarget.value); }}
          onChange={(event) => setComment(event.target.value)} />
        <p id={`${id}-note`} className="reaction-note">{t(labels.note)}</p>
      </div>
      <div className="reaction-trap" aria-hidden="true">
        <label htmlFor={`${id}-website`}>{t("try.trap")}</label>
        <input ref={trap} id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
    </>
  );
}
