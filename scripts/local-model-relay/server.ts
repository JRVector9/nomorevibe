/** M1 전용 private forwarder. Next 웹·renderer·oMLX 설정과 독립 실행한다. */
import { localModelRelayConfig } from "./config";
import { createLocalModelRelay } from "./service";
import { fileRelayReceiptStore } from "./store";
import { relayNativeReadinessVerifier } from "./readiness";

const fail = (code: string): never => {
  console.error(JSON.stringify({ event: "local_model_relay.refused", code })); process.exit(1);
};

async function main() {
  const mode = process.argv[2] ?? "serve";
  if (!["serve", "check", "status"].includes(mode) || process.argv.length > 3) fail("invalid_mode");
  const config = (() => { try { return localModelRelayConfig(); } catch { return fail("invalid_config"); } })();
  if (mode === "check") {
    console.log(JSON.stringify({ event: "local_model_relay.config_valid", host: config.host, port: config.port,
      allowedClients: config.allowFrom.length, model: config.model, relayRevision: config.relayRevision,
      deploymentRevision: config.deploymentRevision, upstream: "127.0.0.1:8000", nativeCapacityReady: false }));
  } else if (mode === "status") {
    try {
      const response = await fetch(`http://${config.host}:${config.port}/v1/health`, {
        headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) fail("status_unavailable");
      console.log(JSON.stringify(await response.json()));
    } catch { fail("status_unavailable"); }
  } else {
    if (typeof process.getuid === "function" && process.getuid() === 0) fail("root_not_allowed");
    const service = createLocalModelRelay({ ...config, store: fileRelayReceiptStore(config.stateDirectory),
      verifyNativeReadiness: relayNativeReadinessVerifier(`http://${config.host}:${config.port}/v1/chat/completions`) });
    service.on("error", () => fail("listen_failed"));
    service.listen(config.port, config.host, () => console.log(JSON.stringify({ event: "local_model_relay.listening",
      host: config.host, port: config.port, relayRevision: config.relayRevision, nativeCapacityReady: false })));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true; service.drain();
      let closed = false;
      service.close(() => { closed = true; });
      // 부른 쪽이 먼저 끊겼어도 upstream drain·receipt 기록이 끝나기 전 프로세스를 종료하지 않는다.
      const poll = setInterval(() => { if (closed && !service.relayHealth().busy) { clearInterval(poll); process.exit(0); } }, 50);
      setTimeout(() => process.exit(1), 95_000).unref();
    };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }
}

void main().catch(() => fail("startup_failed"));
