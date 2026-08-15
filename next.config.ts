import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker/Dokploy 배포용 — .next/standalone만 복사해도 동작하게
  output: "standalone",
  // skill/SKILL.md는 빌드 산출물이 아니므로 명시적으로 포함시켜야 /skill.md가 런타임에 읽을 수 있다
  outputFileTracingIncludes: {
    "/skill.md": ["./skill/SKILL.md"],
  },
};

export default nextConfig;
