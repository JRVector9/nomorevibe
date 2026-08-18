/**
 * 테두리 있는 상자 하나.
 *
 * 어드민 화면마다 같은 상자를 각자 정의하고 있었다(설정의 Section, 현황의 Card).
 * 제목과 설명을 받는 모양이 같으므로 하나로 둔다.
 *
 * tone은 상자의 성격이다 — 기본은 정보, warn은 사람이 봐야 할 것, danger는 되돌리기
 * 어려운 것. 색을 호출부마다 적으면 같은 뜻에 다른 색이 붙는다.
 */
export type PanelTone = "default" | "warn" | "danger";

const TONES: Record<PanelTone, string> = {
  default: "border-line bg-bg-card",
  warn: "border-accent bg-accent-soft",
  danger: "border-down/40 bg-down/5",
};

export function Panel({
  title,
  note,
  tone = "default",
  actions,
  children,
}: {
  title?: string;
  note?: string;
  tone?: PanelTone;
  /** 제목 줄 오른쪽에 붙는 것 (개수 표시 등) */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className={`rounded-[14px] border p-[22px] ${TONES[tone]}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-baseline gap-2">
          {title && <h2 className="text-[15px] font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {note && <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-[1.7] text-fg-2">{note}</p>}
      {children && <div className={title || note ? "mt-4" : ""}>{children}</div>}
    </section>
  );
}
