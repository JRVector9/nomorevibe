// 실제 격리 프로세스(PR15d): 공유 HTTP permit 으로 hop 하나를 dispatch 하고 본문을 읽지 않은 채 머문다.
// 부모가 이 프로세스 그룹을 SIGKILL 한다. 요청·DB·dispatcher 모의 없음. hop 의 boot 는 슈퍼바이저 env(PROCESS_GROUP_OWNER_*)에서 온다.
import { requestOriginHop } from '../../../lib/net/origin-permits';
void (async () => {
  const response = await requestOriginHop(process.env.DR_RECLAIM_HOP_URL!, { redirect: 'manual', signal: new AbortController().signal, headers: {} });
  process.send?.({ kind: 'headers', status: response.status });
  await new Promise(() => {});
})().catch(error => { process.send?.({ kind: 'error', message: String(error) }); });
