/**
 * 릴리스 식별자를 Next 의 빌드 ID 로 쓴다 — deploymentId 로 쓰지 않는다(2026-11-11).
 *
 * CI·Dockerfile·배포 도구는 릴리스 값을 NEXT_DEPLOYMENT_ID 라는 이름으로 넘긴다(웹 이미지는 `tree-<트리>`, main 에서 새로 빌드하면 커밋).
 * 그 값이 Next 16 의 deploymentId 가 되면 모든 정적 파일 주소에 `?dpl=<값>` 이 붙는다(standalone 은 supportsImmutableAssets 를
 * 강제로 끈다, next/dist/server/config.js). 파일 이름은 내용 해시라 그대로인데 주소의 쿼리가 배포마다 바뀌어 Cloudflare 와 브라우저가
 * 같은 파일을 배포마다 다시 받았다. Next 는 `dpl` 쿼리로 길을 고르지 않는다 — 옛 파일을 지켜 주지도 않는다.
 *
 * 버전 어긋남 판별은 빌드 ID 로 그대로 남는다: deploymentId 가 없으면 서버가 RSC 응답(화면 이동·미리 받기·서버 액션)에 빌드 ID(`b`)를
 * 싣고, 클라이언트는 첫 화면의 `b` 와 다르면 전체 새로고침한다(next/dist/client/components/router-reducer/fetch-server-response.js,
 * segment-cache/cache.js, server-action-reducer.js — `x-nextjs-deployment-id ?? b` 비교). 같은 트리 = 같은 빌드 ID 라 두 웹(M3·mini)도 같다.
 *
 * Next 는 환경변수 NEXT_DEPLOYMENT_ID 를 설정 파일보다 앞세워 deploymentId 로 쓴다(next/dist/server/config.js
 * `if (process.env.NEXT_DEPLOYMENT_ID) result.deploymentId = …`). 그래서 설정을 읽는 순간 값을 옮기고 그 이름을 지운다.
 * 같은 프로세스에서 설정을 다시 읽어도 같은 값이 나오게 옮긴 값(NMV_RELEASE_BUILD_ID)을 먼저 본다.
 */
export const RELEASE_BUILD_ID_ENV = "NMV_RELEASE_BUILD_ID";

/** 경로 조각(.next/static/<빌드 ID>/)과 HTTP 헤더에 그대로 들어간다 — 글자를 좁힌다 */
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function takeReleaseBuildId(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[RELEASE_BUILD_ID_ENV]?.trim() || env.NEXT_DEPLOYMENT_ID?.trim() || undefined;
  delete env.NEXT_DEPLOYMENT_ID;
  if (value === undefined) return undefined;
  if (!BUILD_ID.test(value)) throw new Error(`release build id must match ${BUILD_ID}: ${JSON.stringify(value.slice(0, 40))}`);
  env[RELEASE_BUILD_ID_ENV] = value;
  return value;
}
