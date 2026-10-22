'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads must execute as CommonJS before Kuma's entrypoint. */

/** Oracle's dedicated Kuma 2.3.2 only. Startup preload; no network/DB/config writes.
 * Observe official Telegram sendMessage HTTP acknowledgements without changing results/errors.
 * Logs exactly these fields: event, at, monitorId, status, ok, apiAccepted, receiptPresent.
 * No message IDs, notification configuration, text, URLs, tokens, or exception data are logged.
 */
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const installedKey = Symbol.for('nomorevibe.kuma.telegram.delivery-audit.20261022');

if (!globalThis[installedKey]) {
  globalThis[installedKey] = true;
  const context = new AsyncLocalStorage();
  const notificationPath = '/app/server/notification.js';
  // Resolve without loading either Kuma or Axios early: preserve application import order.
  const axiosPath = Module.createRequire('/app/package.json').resolve('axios');
  const originalLoad = Module._load;
  const originalResolve = Module._resolveFilename;
  const hookedAxios = new WeakSet();
  const hookedNotifications = new WeakSet();
  let axiosReady = false;
  let notificationReady = false;

  const monitorId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  const statusCode = value => Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;

  function isOfficialSend(config) {
    try {
      if (!config || typeof config.url !== 'string') return false;
      const url = config.baseURL ? new URL(config.url, config.baseURL) : new URL(config.url);
      return url.protocol === 'https:' && url.hostname === 'api.telegram.org' && url.port === ''
        && !url.username && !url.password && /^\/bot[^/]+\/sendMessage$/.test(url.pathname);
    } catch { return false; }
  }

  function observe(response, requestConfig) {
    // Observation must never turn a successful provider operation into a failure.
    try {
      const record = context.getStore();
      if (!record || !isOfficialSend(requestConfig || response?.config)) return;
      const data = response?.data;
      const successfulHttp = Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
      record.apiAccepted = !!(successfulHttp && data && typeof data === 'object' && data.ok === true);
      record.receiptPresent = !!(record.apiAccepted && data.result && Number.isSafeInteger(data.result.message_id)
        && data.result.message_id > 0);
    } catch {}
  }

  function emit(record, completed) {
    try {
      // Deliberately construct a new object from primitive allow-listed values.
      fs.writeSync(1, JSON.stringify({
        event: 'notification_delivery', at: new Date().toISOString(),
        monitorId: record.monitorId, status: record.status,
        ok: !!(completed && record.apiAccepted && record.receiptPresent),
        apiAccepted: !!record.apiAccepted, receiptPresent: !!record.receiptPresent,
      }) + '\n');
    } catch {}
  }

  function hookAxios(exported) {
    const axios = exported?.interceptors?.response ? exported : exported?.default;
    if (!axios || !axios.interceptors?.response || hookedAxios.has(axios)) return;
    axios.interceptors.response.use(response => {
      observe(response);
      return response;
    }, error => {
      observe(error?.response, error?.config || error?.response?.config);
      throw error; // Preserve the exact original exception object.
    });
    hookedAxios.add(axios);
    axiosReady = true;
  }

  function hookNotification(exported) {
    const Notification = exported?.Notification;
    if (!Notification || typeof Notification.send !== 'function' || hookedNotifications.has(Notification)) return;
    const originalSend = Notification.send;
    const descriptor = Object.getOwnPropertyDescriptor(Notification, 'send');
    const wrapped = function (...args) {
      if (args[0]?.type !== 'telegram') return Reflect.apply(originalSend, this, args);
      const record = {
        monitorId: monitorId(args[2]?.id ?? args[3]?.monitorID),
        status: statusCode(args[3]?.status), apiAccepted: false, receiptPresent: false,
      };
      return context.run(record, () => {
        let result;
        try { result = Reflect.apply(originalSend, this, args); }
        catch (error) { emit(record, false); throw error; }
        return Promise.resolve(result).then(value => {
          emit(record, true);
          return value;
        }, error => {
          emit(record, false);
          throw error; // No replacement error, message, or stack is constructed.
        });
      });
    };
    Object.defineProperty(Notification, 'send', { ...descriptor, value: wrapped });
    hookedNotifications.add(Notification);
    notificationReady = true;
  }

  const loadWithAudit = function (request, parent, isMain) {
    const exported = Reflect.apply(originalLoad, this, arguments);
    try {
      const path = Reflect.apply(originalResolve, Module, [request, parent, isMain]);
      if (path === axiosPath) hookAxios(exported);
      if (path === notificationPath) hookNotification(exported);
      // Remove the loader hook once both normal imports have been observed.
      if (axiosReady && notificationReady && Module._load === loadWithAudit) Module._load = originalLoad;
    } catch {
      // An audit-hook failure must not change Kuma's original loading behavior.
    }
    return exported;
  };
  Module._load = loadWithAudit;
}
