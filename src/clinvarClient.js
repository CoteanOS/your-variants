/**
 * clinvarClient.js - import THIS from React (not the worker).
 *
 * Web build: spins up clinvarWorker.js (SQLite in the browser over OPFS).
 * Desktop build (Tauri): the database lives in the app's data folder and is
 * downloaded and queried by the Rust side, so no worker is started.
 */

const IS_TAURI = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/** Call a Rust command. Rust errors arrive as plain strings; wrap them. */
async function invokeRust(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : (e && e.message) || String(e), { cause: e });
  }
}

let worker = null;
let nextId = 1;
const pending = new Map();
let progressCb = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./clinvarWorker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === "progress") {
      if (progressCb) progressCb(msg.received, msg.total);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  };
  return worker;
}

function call(method, args) {
  ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

export async function initDb({ url, onProgress, forceReload = false } = {}) {
  if (IS_TAURI) {
    const { listen } = await import("@tauri-apps/api/event");
    const stop = await listen("db-progress", (e) => {
      if (onProgress) onProgress(e.payload.received, e.payload.total);
    });
    try {
      return await invokeRust("ensure_db");
    } finally {
      stop();
    }
  }
  progressCb = onProgress || null;
  return call("init", { url, forceReload });
}

export const lookupByGene = (gene, limit) => call("lookupByGene", { gene, limit });
export const lookupByRsid = (rsid) => call("lookupByRsid", { rsid });
export const matchRsids = (rsids) =>
  IS_TAURI
    ? invokeRust("match_rsids", { rsids: rsids.filter(Number.isInteger) })
    : call("matchRsids", { rsids });
