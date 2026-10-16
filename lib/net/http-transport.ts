import { Agent, fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { lookup as dnsLookup } from "node:dns";
import { allowPrivate, isPrivateIp } from "./ssrf";

/**
 * 연결 시점 DNS 검증 — 1차 검사와 실제 연결 사이에 레코드를 바꾸는 DNS 리바인딩을 차단한다.
 *
 * 주의: net.connect의 autoSelectFamily(Node 20+ 기본)는 lookup을 { all: true }로 호출하고
 * 주소 "배열"을 기대한다. 단일 주소 형태로만 응답하면 모든 연결이 ERR_INVALID_IP_ADDRESS로 실패한다.
 */
const ssrfSafeAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = Array.isArray(addresses) ? addresses : [];
        if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
          return callback(new Error(`사설 IP 차단: ${hostname}`), "", 4);
        }
        if (options?.all) {
          return (callback as unknown as (e: Error | null, a: typeof list) => void)(null, list);
        }
        callback(null, list[0].address, list[0].family);
      });
    },
  },
});

export const legacyHttpDispatcher = () => allowPrivate() ? undefined : ssrfSafeAgent;
export const httpDispatcher = () => allowPrivate() ? getGlobalDispatcher() : ssrfSafeAgent;
export const nativeHttpFetch = undiciFetch;
