import Link from "next/link";
import { Icon } from "@/components/home/icons";

export function HomeHero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div>
        <div className="eyebrow">BUILT WITH AI. SHIPPED BY PEOPLE.</div>
        <h1 id="hero-title">AI로 만든 것들, 세상에 나오다.</h1>
        <p className="subtitle">
          작은 아이디어에서 실제 서비스까지. <b>프로젝트를 발견하고, AI의 다음 흐름을 만나세요.</b>
        </p>
      </div>
      <div className="hero-right">
        <span>만드는 곳에서, 바로 세상으로.</span>
        <Link className="hero-command" href="/launch">
          <code><em>/nomorevibe</em> launch</code>
          <Icon name="arrow-up-right" size={16} />
        </Link>
      </div>
    </section>
  );
}
