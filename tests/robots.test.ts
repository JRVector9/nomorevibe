import { describe, it, expect, afterEach } from "vitest";
import robots, { dynamic } from "@/app/robots";

/**
 * robots.txt는 sitemap 주소를 담는다.
 *
 * metadata route는 기본이 빌드 시점 정적 생성이다. 그대로 두면 NEXT_PUBLIC_SITE_URL이 없는
 * Dockerfile 빌더 단계에서 값이 정해져 `Sitemap: http://localhost:3000/sitemap.xml`이 이미지에
 * 박히고, 운영 중인 사이트가 크롤러에게 영영 localhost를 알려준다.
 */
describe("robots.txt", () => {
  // tests/setup-env.ts가 단위 테스트에서 이 변수를 지우므로 여기서 직접 세운다
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("sitemap 주소를 그때그때 NEXT_PUBLIC_SITE_URL에서 읽는다", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://nomorevibe.app";
    expect(robots().sitemap).toBe("https://nomorevibe.app/sitemap.xml");

    // 값이 바뀌면 결과도 바뀌어야 한다 — 한 번 계산해 굳혀두면 안 된다
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.nomorevibe.app/";
    expect(robots().sitemap).toBe("https://staging.nomorevibe.app/sitemap.xml");
  });

  it("빌드 시점에 굳히지 않는다 — sitemap.ts와 같다", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});
