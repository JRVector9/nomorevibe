/**
 * 워커 프로세스가 "server-only" 표시가 달린 읽기 모듈(운영 홈의 할 일 읽기 — console-home-read.ts 등)을 가져올 수 있게 한다(운영 콘솔 조각 4b).
 *
 * "server-only" 는 브라우저 묶음에 서버 모듈이 끌려 들어가는 것을 막는 표시다 — 기본 조건으로 가져오면 던지고, React 서버 조건(react-server)에서는 빈 모듈이다.
 * 워커는 서버이므로 그 표시만 서버 조건으로 풀어 준다(Node 의 동기 모듈 훅 module.registerHooks — Node 22.15+/24). 다른 모듈의 해석은 바꾸지 않는다.
 * 지금까지 워커는 이 표시가 달린 모듈을 가져오지 못했으므로(가져오면 던졌다) 훅을 걸어도 이미 도는 잡의 동작은 그대로다. 한 프로세스에 한 번만 건다.
 */
type ResolveContext = { conditions?: readonly string[] } & Record<string, unknown>;
type ResolveHook = (specifier: string, context: ResolveContext, nextResolve: (specifier: string, context?: ResolveContext) => unknown) => unknown;

let registered = false;

export async function allowServerOnlyModules(): Promise<void> {
  if (registered) return;
  const nodeModule = await import("node:module") as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => unknown };
  if (typeof nodeModule.registerHooks !== "function") throw new Error("server_only_hook_unavailable");
  nodeModule.registerHooks({
    resolve: (specifier, context, nextResolve) => specifier === "server-only"
      ? nextResolve(specifier, { ...context, conditions: [...(context.conditions ?? []), "react-server"] })
      : nextResolve(specifier, context),
  });
  registered = true;
}
