import { Icon } from "@/components/home/icons";
import { trackAttrs } from "@/lib/analytics/attrs";
import type { Labels } from "./views";

/**
 * 저장 단추의 모양 — 누르는 일은 부르는 쪽(SaveToggle·ProjectCard)이 정한다.
 * 카드 마크업(markup.tsx)과 따로 둔다 — 서버가 그린 카드의 저장 단추(SaveToggle)가 카드 그리기 코드 전체를 첫 로드 JS 로 끌고 오지 않게.
 */
export function SaveButtonMarkup({ slug, name, saved, onClick, t }: { slug: string; name: string; saved: boolean; onClick?: () => void; t: Labels }) {
  return (
    <button
      type="button"
      className={`cover-saved${saved ? " active" : ""}`}
      aria-label={t(saved ? "card.unsave" : "card.save", { name })}
      aria-pressed={saved}
      onClick={onClick}
      {...trackAttrs("product_save", { product_slug: slug, action: saved ? "unsave" : "save" })}
    >
      <Icon name="bookmark" size={16} />
    </button>
  );
}
