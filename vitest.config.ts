import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * "use client" 파일의 부품에 경계 표시를 단다 — 공개 HTML 데이터 시험(tests/public-html-payload*.test.tsx)이
 * 서버 부품은 펼치고 브라우저 부품에서 멈춰, RSC 데이터로 넘어갈 속성만 모은다. 다른 시험에는 영향이 없다(보이지 않는 속성 하나).
 */
const CLIENT_DIRECTIVE = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*["']use client["']/;
function clientBoundaryMarker(): Plugin {
  return {
    name: "nmv-client-boundary-marker",
    enforce: "post",
    transform(code, id) {
      if (id.includes("/node_modules/") || !/\.(?:tsx?|jsx?)$/.test(id.split("?")[0]) || !CLIENT_DIRECTIVE.test(code)) return null;
      const names = [...code.matchAll(/export\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g), ...code.matchAll(/export\s+const\s+([A-Z][\w$]*)\s*=/g)]
        .map((match) => match[1]);
      if (names.length === 0) return null;
      return { code: `${code}\n;for (const c of [${names.join(", ")}]) if (typeof c === "function") Object.defineProperty(c, "$$nmvClientBoundary", { value: true });\n`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [clientBoundaryMarker()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 통합 테스트는 DB가 필요하므로 별도 설정(vitest.integration.config.ts)으로 돌린다
    exclude: ["tests/integration/**"],
    // 셸에 떠 있는 개발용 환경변수가 결과를 바꾸지 않게 한다
    setupFiles: ["tests/setup-env.ts"],
    // 기본값(코어 수 - 1)은 64코어 기기에서 worker 63개다. 모듈 변환을 기다리는 시간이 늘어(변환 합계 26초@16 → 477초@63)
    // 테스트 안에서 처음 읽는 화면·route 모듈이 기본 5초를 넘었다 — 40개부터 실패, 32개 이하는 통과했다. 여유를 두고 20개로 묶는다.
    // CI(4 vCPU → 3개)는 그대로다.
    maxWorkers: Math.max(1, Math.min(availableParallelism() - 1, 20)),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // 관리자 글꼴(app/(operator)/admin/console-fonts.ts) — 진짜 함수는 Next 컴파일러가 빌드 때 넣는다. 시험에서는 빈 값
      "next/font/google": path.resolve(__dirname, "tests/stubs/next-font-google.ts"),
    },
  },
});
