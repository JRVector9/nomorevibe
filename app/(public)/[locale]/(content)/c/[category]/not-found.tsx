import Link from "next/link";
import { CategoryLinks } from "./CategoryLinks";

/** /c/<모르는 값> — 조용히 전체 목록을 보이지 않고 없다고 말한 뒤 고를 분야를 준다(UX-40) */
export default function CategoryNotFound() {
  return (
    <main className="wrap">
      <section className="feed" aria-labelledby="category-missing-title">
        <div className="empty-state">
          <h1 id="category-missing-title" className="row-title">없는 분야입니다</h1>
          <p>주소의 분야 이름을 확인하거나 아래에서 고르세요.</p>
          <CategoryLinks />
          <Link prefetch={false} href="/" className="secondary">홈으로</Link>
        </div>
      </section>
    </main>
  );
}
