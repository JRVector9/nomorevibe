/**
 * 켜고 끄는 스위치 — 속은 체크박스라 폼이 그대로 "on" 을 보낸다(끄면 값이 빠진다).
 * 손대지 않는 입력이라 저장 전까지 상태를 들고 있지 않는다.
 */
export function Switch({ name, defaultChecked, label, className = "", inputClassName = "" }: {
  name: string; defaultChecked: boolean; label: string; className?: string; inputClassName?: string;
}) {
  return (
    <label className={`relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer ${className}`}>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} aria-label={label}
        className={`peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 ${inputClassName}`} />
      <span aria-hidden className="absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-up peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40
        after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform after:content-['']
        peer-checked:after:translate-x-4" />
    </label>
  );
}

/** 설정 한 구획 — 제목 줄 오른쪽에 개수·스위치 같은 것을 붙인다 */
export function SettingsCard({ id, title, note, actions, children }: {
  id?: string; title: string; note?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex min-w-0 scroll-mt-6 flex-col gap-4 rounded-[12px] border border-line bg-bg-card px-[22px] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          {note && <p className="text-[13px] text-fg-3">{note}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** 너비 없는 입력칸 — 너비는 쓰는 곳이 정한다(w-full 과 w-24 를 함께 주면 어느 쪽이 이길지 CSS 순서에 달린다) */
export const inputBase = "min-h-[38px] rounded-[9px] border border-line bg-bg-card px-3 py-2 text-[14px] text-fg outline-none focus:border-accent";
export const inputClass = `${inputBase} w-full`;
export const hintClass = "text-[13px] leading-[1.6] text-fg-3";
export const labelClass = "text-[13px] font-semibold text-fg-2";
export const chipClass = "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold";
/** 버튼 갈래 — 같은 속성(높이·테두리·글자색)을 덧씌우면 어느 쪽이 이길지 CSS 순서에 달려서 갈래마다 따로 적는다 */
const buttonBase = "inline-flex items-center gap-1.5 rounded-[9px] border text-[13px] font-semibold hover:bg-bg-soft disabled:opacity-50";
export const buttonClass = `${buttonBase} min-h-9 justify-center border-line bg-bg-card px-3.5 text-fg`;
export const buttonSmall = `${buttonBase} min-h-[30px] justify-center border-line bg-bg-card px-3 text-fg`;
export const buttonGhost = `${buttonBase} min-h-9 justify-center border-transparent px-3 text-accent-ink`;
export const buttonQuiet = `${buttonBase} min-h-[30px] justify-center border-transparent px-2 text-fg-3 hover:text-fg`;
export const buttonDashed = `${buttonBase} min-h-9 justify-start border-dashed border-line px-3.5 text-fg-3`;
