import Link from "next/link";

const n = (value: number) => value.toLocaleString("ko-KR");
export type TodoCard = { key: string; title: string; detail: string; count: number; href: string; tone?: "ok" | "warn" | "bad" };

/**
 * 지금 할 일 — 구간 수를 되풀이하지 않고 "무엇을 하면 되는지"만. 0건인 카드도 자리를 지킨다(날마다 옮겨 다니지 않게).
 */
export function ReviewTodo({ cards }: { cards: TodoCard[] }) {
  return (
    <ul className="rq-todo" aria-label="지금 할 일">
      {cards.map((card) => (
        <li key={card.key}>
          <Link href={card.href} data-tone={card.tone} data-zero={card.count === 0 || undefined}>
            <i aria-hidden />
            <span className="x"><span className="t">{card.title}</span><span className="d" title={card.detail}>{card.detail}</span></span>
            <span className="n">{n(card.count)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
