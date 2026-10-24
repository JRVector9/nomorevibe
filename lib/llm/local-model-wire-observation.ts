/** 전송 관측용 메타데이터다. native dispatch·terminal·DB 변경 권한을 발급하지 않는다. */
const observations = new WeakMap<Response, Readonly<{ wireHash: string }>>();

export function recordLocalModelWireObservation(response: Response, wireHash: string): void {
  if (!/^[a-f0-9]{64}$/.test(wireHash)) throw new TypeError("invalid_local_model_wire_hash");
  observations.set(response, Object.freeze({ wireHash }));
}

/** 원래 Response 객체의 관측만 읽으며 서버가 보낸 동명 헤더는 사용하지 않는다. */
export function observedLocalModelWireHash(response: Response): string | undefined {
  return observations.get(response)?.wireHash;
}
