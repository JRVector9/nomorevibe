import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { it } from "vitest";

// Exercise the actual startup preload with fake Kuma/Axios modules: no DB, credentials, or network.
const source = readFileSync(new URL("../scripts/ops/kuma-delivery-audit.cjs", import.meta.url), "utf8");
const axiosPath = "/app/node_modules/axios/dist/node/axios.cjs";
const notificationPath = "/app/server/notification.js";
const privateToken = "DO_NOT_LOG_BOT_TOKEN";
const privateText = "DO_NOT_LOG_NOTIFICATION_TEXT";

type Config = { url: string };
type Response = { status: number; config: Config; data: unknown };
type Failure = Error & { config?: Config; response?: Response };
type Input = { type: string; url?: string; httpStatus?: number; data?: unknown; error?: Failure;
  response?: Response; wait?: Promise<void>; responseWait?: Promise<void>; skipAxios?: boolean; afterError?: Error; returnValue?: object };
type Args = [Input, string, { id: number; name?: string }, { status: number; msg?: string }];
type Audit = { event: string; at: string; monitorId: number | null; status: number | null;
  ok: boolean; apiAccepted: boolean; receiptPresent: boolean };
type Success = (response: Response) => Response;
type Rejection = (error: Failure) => never;

function fixture() {
  const logs: Audit[] = [];
  const calls: { receiver: typeof Notification; args: Args }[] = [];
  const loadOrder: string[] = [];
  const handlers: [Success, Rejection][] = [];
  const state = { stdoutFails: false };
  const axios = {
    interceptors: { response: { use(success: Success, failure: Rejection) {
      handlers.push([success, failure]); return handlers.length - 1;
    } } },
    request(notification: Input) {
      const config = { url: notification.url || `https://api.telegram.org/bot${privateToken}/sendMessage` };
      const response = { status: notification.httpStatus ?? 200, config,
        data: notification.data || { ok: true, result: { message_id: 92345678, text: privateText } } };
      if (notification.error) {
        notification.error.config = config;
        notification.error.response = notification.response;
      }
      const complete = () => notification.error ? Promise.reject(notification.error) : Promise.resolve(response);
      let result: Promise<Response> = notification.responseWait ? notification.responseWait.then(complete) : complete();
      for (const [success, failure] of handlers) result = result.then(success, failure);
      return result;
    },
  };
  const returned = {};
  class Notification {
    static async send(...args: Args) {
      calls.push({ receiver: this, args });
      if (args[0].type === "telegram") {
        if (args[0].wait) await args[0].wait;
        if (!args[0].skipAxios) await axios.request(args[0]);
        if (args[0].afterError) throw args[0].afterError;
      }
      return args[0].returnValue || returned;
    }
  }
  const fakeModule = {
    createRequire() { return { resolve(request: string) { assert.equal(request, "axios"); return axiosPath; } }; },
    _resolveFilename(request: string) {
      if (request === "axios") return axiosPath;
      if (request === "./notification" || request === notificationPath) return notificationPath;
      throw new Error("unexpected offline module");
    },
    _load: (request: string): unknown => { throw new Error("not initialized: " + request); },
  };
  const originalLoad = fakeModule._load = function (request: string): unknown {
    const path = fakeModule._resolveFilename(request);
    loadOrder.push(path);
    if (path === axiosPath) return axios;
    // Model Axios loading naturally inside Notification's normal dependency graph.
    fakeModule._load("axios");
    return { Notification };
  };
  const sandbox = vm.createContext({
    URL, require(name: string) {
      if (name === "node:module") return fakeModule;
      if (name === "node:async_hooks") return { AsyncLocalStorage };
      if (name === "node:fs") return { writeSync(fd: number, value: string) {
        assert.equal(fd, 1);
        if (state.stdoutFails) throw new Error("fake stdout failure");
        logs.push(JSON.parse(value));
      } };
      throw new Error("unexpected real require");
    },
  });
  vm.runInContext(source, sandbox, { filename: "kuma-delivery-audit.cjs" });
  assert.equal(loadOrder.length, 0, "preload must not eagerly load Kuma or Axios");
  fakeModule._load("./notification");
  assert.equal(fakeModule._load, originalLoad, "temporary loader hook removed after normal imports");
  assert.equal(handlers.length, 1);
  return { logs, calls, state, Notification, returned };
}

function assertSafe(log: Audit) {
  assert.deepEqual(Object.keys(log).sort(), ["apiAccepted", "at", "event", "monitorId", "ok", "receiptPresent", "status"].sort());
  assert.equal(log.event, "notification_delivery");
  const text = JSON.stringify(log);
  for (const secret of [privateToken, privateText, "92345678", "https://", "message_id"]) assert.ok(!text.includes(secret));
}

it("records an acknowledged official Telegram receipt, keeps the original call/result, and omits secrets", async () => {
  const f = fixture();
  const config = { type: "telegram" };
  const monitor = { id: 7, name: privateText };
  const heartbeat = { status: 0, msg: privateText };
  assert.equal(await f.Notification.send(config, privateText, monitor, heartbeat), f.returned);
  assert.equal(f.calls[0].receiver, f.Notification);
  assert.deepEqual(f.calls[0].args, [config, privateText, monitor, heartbeat]);
  assert.equal(f.logs.length, 1);
  assert.deepEqual([f.logs[0].monitorId, f.logs[0].status, f.logs[0].ok, f.logs[0].apiAccepted, f.logs[0].receiptPresent], [7, 0, true, true, true]);
  assertSafe(f.logs[0]);
});

it("records a safe failure and rethrows the identical original provider exception", async () => {
  const f = fixture();
  const error = new Error(privateToken + privateText);
  await assert.rejects(f.Notification.send({ type: "telegram", error }, privateText, { id: 8 }, { status: 1 }), caught => caught === error);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].ok, false);
  assert.equal(f.logs[0].apiAccepted, false);
  assertSafe(f.logs[0]);
});

it.each<Input>([
  { type: "telegram", data: { ok: false } },
  { type: "telegram", data: { ok: true, result: {} } },
  { type: "telegram", data: { ok: true, result: { message_id: 0 } } },
  { type: "telegram", httpStatus: 500 },
  { type: "telegram", url: `https://api.telegram.org.evil.invalid/bot${privateToken}/sendMessage` },
  { type: "telegram", url: `https://api.telegram.org/bot${privateToken}/getMe` },
  { type: "telegram", url: `http://api.telegram.org/bot${privateToken}/sendMessage` },
  { type: "telegram", skipAxios: true },
])("does not claim delivery without a valid official acknowledgement: %j", async config => {
  const f = fixture();
  assert.equal(await f.Notification.send(config, privateText, { id: 9 }, { status: 0 }), f.returned);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].ok, false);
  assertSafe(f.logs[0]);
});

it("leaves other notification providers unchanged and unaudited", async () => {
  const f = fixture();
  assert.equal(await f.Notification.send({ type: "other" }, privateText, { id: 10 }, { status: 1 }), f.returned);
  assert.equal(f.logs.length, 0);
});

it("keeps concurrent Telegram sends in distinct AsyncLocalStorage contexts", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const slow = f.Notification.send({ type: "telegram", wait }, privateText, { id: 11 }, { status: 0 });
  const fast = f.Notification.send({ type: "telegram" }, privateText, { id: 12 }, { status: 1 });
  await fast;
  release(); await slow;
  assert.deepEqual(f.logs.map(log => [log.monitorId, log.status]), [[12, 1], [11, 0]]);
  f.logs.forEach(assertSafe);
});

it("separates success and failure receipts when concurrent HTTP requests finish in reverse order", async () => {
  const f = fixture();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstResponse = new Promise<void>(resolve => { finishFirst = resolve; });
  const secondResponse = new Promise<void>(resolve => { finishSecond = resolve; });
  const error = new Error(privateToken + privateText);
  const accepted = f.Notification.send({ type: "telegram", responseWait: firstResponse }, privateText, { id: 21 }, { status: 1 });
  const rejected = f.Notification.send({ type: "telegram", responseWait: secondResponse, error,
    response: { status: 503, config: { url: `https://api.telegram.org/bot${privateToken}/sendMessage` }, data: { ok: false } },
  }, privateText, { id: 22 }, { status: 0 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.logs.length, 0, "neither HTTP response has completed");
  const rejection = assert.rejects(rejected, caught => caught === error);
  // Resolve both transports in the same turn, opposite their start order. Both Axios
  // interceptors run before provider completion, exposing any shared receipt flags.
  finishSecond();
  finishFirst();
  const [result] = await Promise.all([accepted, rejection]);
  assert.equal(result, f.returned);
  assert.deepEqual(f.logs.map(log => [log.monitorId, log.status, log.ok, log.apiAccepted, log.receiptPresent]), [
    [22, 0, false, false, false],
    [21, 1, true, true, true],
  ]);
  f.logs.forEach(assertSafe);
});

it("does not alter a provider result or exception when audit stdout fails", async () => {
  const f = fixture();
  f.state.stdoutFails = true;
  assert.equal(await f.Notification.send({ type: "telegram" }, privateText, { id: 13 }, { status: 1 }), f.returned);
  const error = new Error(privateText);
  await assert.rejects(f.Notification.send({ type: "telegram", error }, privateText, { id: 13 }, { status: 0 }), caught => caught === error);
});

it("preserves a post-acknowledgement provider exception while retaining the receipt evidence", async () => {
  const f = fixture();
  const error = new Error("provider error after acknowledged HTTP response");
  await assert.rejects(f.Notification.send({ type: "telegram", afterError: error }, privateText, { id: 14 }, { status: 0 }), caught => caught === error);
  assert.equal(f.logs[0].ok, false);
  assert.equal(f.logs[0].apiAccepted, true);
  assert.equal(f.logs[0].receiptPresent, true);
  assertSafe(f.logs[0]);
});
